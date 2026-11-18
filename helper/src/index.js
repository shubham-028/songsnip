// SongSnip background helper
// ---------------------------------------------------------------------------
// Runs in your own Cloudflare account. While you listen in the Spotify app (phone locked or not),
// it watches what is playing and, at the end of each part you kept, tells Spotify to jump to the
// next part, or straight to the first part of the next song. Nothing runs when nothing is playing.
//
// It only ever talks to Spotify's Web API with your own login, and only answers SongSnip pages
// that know your helper key.
import { DurableObject } from 'cloudflare:workers';

const SCOPES = 'user-read-playback-state user-modify-playback-state';
const IDLE_STOP_MS = 30 * 60 * 1000;   // stop watching after 30 minutes with nothing playing
const DEFAULT_LEAD = 450;              // jump this many ms early, to cover Spotify's delay

export default {
  async fetch(request, env) {
    // one helper per account: every request goes to the same Durable Object
    const stub = env.HELPER.get(env.HELPER.idFromName('main'));
    return stub.fetch(request);
  }
};

// ---------- small helpers ----------
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randStr = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function pkceChallenge(v) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
}
function sameKey(a, b) {                       // constant-time compare
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// the parts to play, in your order (same rules as SongSnip itself)
function playSegs(t, dur) {
  const endCap = (dur || Infinity) - 350;
  const s = (t.segs || []).filter(x => x.end > x.start && x.start < endCap).map(x => ({ start: x.start, end: Math.min(x.end, endCap) }));
  return s.length ? s : [{ start: 0, end: endCap }];
}
const page = (title, body) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px system-ui;background:#0e1014;color:#e9ebf1;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center"><div>${body}</div>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } });

export class Helper extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.api = env.SPOTIFY_API || 'https://api.spotify.com/v1';
    this.accounts = env.SPOTIFY_ACCOUNTS || 'https://accounts.spotify.com';
    this.origins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  // ---------- storage ----------
  get(k) { return this.ctx.storage.get(k); }
  put(k, v) { return this.ctx.storage.put(k, v); }
  async getRun() { return (await this.get('run')) || { active: false }; }
  async log(msg) {
    const log = (await this.get('log')) || [];
    log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
    await this.put('log', log.slice(-25));
  }

  // ---------- HTTP ----------
  cors(origin) {
    if (!origin || !this.origins.includes(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Vary': 'Origin' };
  }
  json(data, status, origin) {
    return new Response(JSON.stringify(data), { status: status || 200, headers: { 'content-type': 'application/json', ...this.cors(origin) } });
  }

  async fetch(request) {
    const url = new URL(request.url), path = url.pathname, origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: this.cors(origin) });
    try {
      if (path === '/') return page('SongSnip helper', 'SongSnip helper is running.');
      if (path === '/login' && request.method === 'GET') return await this.login(url);
      if (path === '/callback' && request.method === 'GET') return await this.callback(url);
      if (path === '/claim' && request.method === 'POST') {
        // the first SongSnip page to set up this helper chooses its key (it never passes through anyone else)
        const { key } = await request.json();
        if (await this.get('key')) return this.json({ error: 'This helper already has a key. Use the pairing link from the device you set it up on.' }, 409, origin);
        if (typeof key !== 'string' || key.length < 24) return this.json({ error: 'key too short' }, 400, origin);
        await this.put('key', key);
        return this.json({ ok: true }, 200, origin);
      }
      // everything else needs the helper key
      const key = await this.get('key');
      const given = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
      if (!key || !sameKey(given, key)) return this.json({ error: 'wrong helper key' }, 401, origin);

      const body = ['POST', 'PUT'].includes(request.method) ? await request.json().catch(() => ({})) : {};
      let out;
      if (path === '/status' && request.method === 'GET') out = await this.status();
      else if (path === '/library' && request.method === 'PUT') out = await this.setLibrary(body);
      else if (path === '/play' && request.method === 'POST') out = await this.play(body);
      else if (path === '/stop' && request.method === 'POST') out = await this.stop();
      else if (path === '/next' && request.method === 'POST') out = await this.skip(1);
      else if (path === '/prev' && request.method === 'POST') out = await this.skip(-1);
      else if (path === '/toggle' && request.method === 'POST') out = await this.toggle();
      else return this.json({ error: 'not found' }, 404, origin);
      return this.json(out, 200, origin);
    } catch (e) {
      return this.json({ error: e.message }, e.status === 404 || e.status === 409 ? 409 : 500, origin);
    }
  }

  // ---------- Spotify login (the helper gets its own login, separate from the SongSnip page's) ----------
  async login(url) {
    const key = await this.get('key');
    if (!key || !sameKey(url.searchParams.get('key') || '', key)) return page('SongSnip helper', 'This link is not valid. Start again from SongSnip ⚙ Settings.');
    const clientId = url.searchParams.get('client_id'), back = url.searchParams.get('return') || '';
    if (!clientId) return page('SongSnip helper', 'Missing Spotify Client ID.');
    const verifier = randStr(48), state = randStr(18);
    await this.put('pkce', { verifier, state, clientId, back, at: Date.now() });
    const p = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES, code_challenge_method: 'S256',
      code_challenge: await pkceChallenge(verifier), redirect_uri: url.origin + '/callback', state });
    return Response.redirect(this.accounts + '/authorize?' + p, 302);
  }
  async callback(url) {
    const pk = await this.get('pkce');
    if (!pk || url.searchParams.get('state') !== pk.state || Date.now() - pk.at > 15 * 60 * 1000) return page('SongSnip helper', 'This login link expired. Start again from SongSnip ⚙ Settings.');
    if (url.searchParams.get('error')) return page('SongSnip helper', 'Spotify login was cancelled: ' + url.searchParams.get('error'));
    const r = await fetch(this.accounts + '/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: url.origin + '/callback',
        client_id: pk.clientId, code_verifier: pk.verifier }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return page('SongSnip helper', 'Spotify login failed: ' + (j.error_description || j.error || r.status) +
      '<br><br>Check that <code>' + url.origin + '/callback</code> is in your Spotify app\'s Redirect URIs.');
    this.auth = { clientId: pk.clientId, access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    await this.put('auth', this.auth); await this.ctx.storage.delete('pkce');
    await this.log('connected to Spotify');
    const back = pk.back && /^https?:\/\//.test(pk.back) ? pk.back : '';
    return page('SongSnip helper', '✅ The helper is connected to your Spotify.<br><br>' +
      (back ? `<a style="color:#1ed760" href="${back.replace(/"/g, '')}">Back to SongSnip</a>` : 'You can close this tab.'));
  }
  async token() {
    this.auth ??= await this.get('auth');
    const a = this.auth;
    if (!a) { const e = new Error('The helper is not connected to Spotify yet. Use "Connect helper to Spotify" in SongSnip ⚙ Settings.'); e.status = 409; throw e; }
    if (Date.now() < a.exp) return a.access;
    const r = await fetch(this.accounts + '/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') { this.auth = null; await this.ctx.storage.delete('auth'); }
      const e = new Error('Spotify login expired: connect the helper again in SongSnip ⚙ Settings.'); e.status = 409; throw e;
    }
    Object.assign(a, { access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    if (j.refresh_token) a.refresh = j.refresh_token;    // Spotify may hand out a new one: keep it
    await this.put('auth', a);
    return a.access;
  }
  async sp(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.token();
      const r = await fetch(this.api + path, { method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401 && attempt === 0) { this.auth.exp = 0; continue; }
      if (r.status === 204 || r.status === 202) return null;
      const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
      if (!r.ok) {
        const e = new Error(j?.error?.message || ('Spotify error ' + r.status)); e.status = r.status;
        e.retryAfter = +(r.headers.get('retry-after') || 0); throw e;
      }
      return j;
    }
  }

  // ---------- commands from SongSnip ----------
  async status() {
    const run = await this.getRun(), auth = await this.get('auth'), lib = (await this.get('lib')) || {};
    return { connected: !!auth, active: !!run.active, now: run.now || null, songs: Object.keys(lib).length,
      lead: run.lead ?? DEFAULT_LEAD, error: run.error || null, log: (await this.get('log')) || [] };
  }
  async setLibrary(body) {
    const lib = {};
    for (const t of body.tracks || []) {
      if (typeof t.uri !== 'string' || !t.uri.startsWith('spotify:track:')) continue;
      lib[t.uri] = { title: String(t.title || '').slice(0, 200), dur: +t.dur || 0,
        segs: (t.segs || []).map(s => ({ start: +s.start, end: +s.end })).filter(s => isFinite(s.start) && isFinite(s.end)) };
    }
    await this.put('lib', lib);
    const run = await this.getRun();
    if (body.lead != null && isFinite(+body.lead)) { run.lead = Math.max(0, Math.min(2000, +body.lead)); await this.put('run', run); }
    return { ok: true, songs: Object.keys(lib).length };
  }
  async pickDevice() {
    const { devices = [] } = (await this.sp('GET', '/me/player/devices')) || {};
    const d = devices.find(x => x.is_active) || devices.find(x => x.type === 'Smartphone') || devices[0];
    if (!d) { const e = new Error('Spotify isn\'t open on any device. Open the Spotify app on your phone (play anything for a second), then press play in SongSnip again.'); e.status = 409; throw e; }
    return d.id;
  }
  async play(body) {
    const lib = (await this.get('lib')) || {};
    const list = (body.uris || []).filter(u => typeof u === 'string' && u.startsWith('spotify:track:'));
    if (!list.length) { const e = new Error('No Spotify songs to play.'); e.status = 409; throw e; }
    const i = Math.max(0, Math.min(list.length - 1, body.index | 0));
    const device = await this.pickDevice();
    const t = lib[list[i]], start = t ? playSegs(t, t.dur)[0].start : 0;
    // we do the ordering, repeating and part-skipping ourselves
    await this.sp('PUT', `/me/player/shuffle?state=false&device_id=${device}`).catch(() => {});
    await this.sp('PUT', `/me/player/play?device_id=${device}`, { uris: list, offset: { position: i }, position_ms: Math.round(start) });
    await this.sp('PUT', `/me/player/repeat?state=off&device_id=${device}`).catch(() => {});
    const run = await this.getRun();
    Object.assign(run, { active: true, list, loop: !!body.loop, device, cur: { uri: list[i], idx: 0 },
      expect: { uri: list[i], pos: start, until: Date.now() + 5000 }, idleSince: null, error: null });
    await this.put('run', run);
    await this.log('started ' + list.length + ' songs');
    await this.ctx.storage.setAlarm(Date.now() + 1200);
    return { ok: true };
  }
  async stop() {
    const run = await this.getRun(); run.active = false; await this.put('run', run);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }
  async toggle() {
    const st = await this.sp('GET', '/me/player');
    if (st?.is_playing) { await this.sp('PUT', '/me/player/pause'); return { playing: false }; }
    await this.sp('PUT', '/me/player/play');
    const run = await this.getRun();
    if (run.list) { run.active = true; run.idleSince = null; await this.put('run', run); await this.ctx.storage.setAlarm(Date.now() + 800); }
    return { playing: true };
  }
  async skip(dir) {
    const run = await this.getRun(), lib = (await this.get('lib')) || {};
    const st = await this.sp('GET', '/me/player');
    if (!st?.item) return { ok: false };
    const uri = this.uriOf(st, lib);
    if (dir > 0) await this.nextSong(run, uri, st, lib);
    else {
      const t = lib[uri], first = t ? playSegs(t, st.item.duration_ms)[0].start : 0;
      const i = run.list ? run.list.indexOf(uri) : -1;
      if (st.progress_ms - first > 3000 || i <= 0 || st.context) await this.seekTo(run, uri, 0, first);
      else {
        const pu = run.list[i - 1], pt = lib[pu], s = pt ? playSegs(pt, pt.dur)[0].start : 0;
        await this.sp('PUT', '/me/player/play', { uris: run.list, offset: { position: i - 1 }, position_ms: Math.round(s) });
        Object.assign(run, { cur: { uri: pu, idx: 0 }, expect: { uri: pu, pos: s, until: Date.now() + 4000 } });
      }
    }
    if (run.list) { run.active = true; run.idleSince = null; }
    await this.put('run', run);
    await this.ctx.storage.setAlarm(Date.now() + 800);
    return { ok: true };
  }

  // ---------- the watcher ----------
  uriOf(st, lib) {
    const l = st.item.linked_from?.uri;           // Spotify sometimes plays a "relinked" copy of a song
    return l && lib[l] ? l : st.item.uri;
  }
  async alarm() {
    const run = await this.getRun();
    if (!run.active) return;
    try {
      const wait = await this.step(run);
      if (run.active) await this.ctx.storage.setAlarm(Date.now() + Math.max(150, wait));
      run.error = null;
    } catch (e) {
      run.error = e.message; await this.log('error: ' + e.message);
      if (e.status === 409 && /not connected|expired/.test(e.message)) run.active = false;
      else await this.ctx.storage.setAlarm(Date.now() + (e.status === 429 ? Math.max(1000, (e.retryAfter || 5) * 1000) : 5000));
    }
    await this.put('run', run);
  }
  // looks at what Spotify is playing, does whatever is needed, and returns how long to sleep (ms)
  async step(run) {
    const lib = (await this.get('lib')) || {};
    const t0 = Date.now();
    const st = await this.sp('GET', '/me/player');
    const now = Date.now(), lat = now - t0;
    if (!st?.item || !st.is_playing) {
      run.idleSince ??= now;
      if (now - run.idleSince > IDLE_STOP_MS) { run.active = false; await this.log('stopped: nothing played for 30 minutes'); }
      run.now = st?.item ? { title: st.item.name, paused: true } : null;
      return 5000;
    }
    run.idleSince = null;
    const uri = this.uriOf(st, lib), dur = st.item.duration_ms;
    const pos = st.progress_ms + lat / 2;           // where the song is right now (roughly)
    run.now = { title: st.item.name, artist: (st.item.artists || []).map(a => a.name).join(', '), uri, pos: Math.round(pos), at: now, snipped: !!lib[uri] };

    // after a jump we just made, wait until Spotify reports it
    if (run.expect && now < run.expect.until) {
      if (run.expect.uri !== uri || Math.abs(pos - run.expect.pos) > 2500) return 300;
    }
    run.expect = null;

    const t = lib[uri];
    if (!t) { run.cur = { uri, idx: 0 }; return Math.min(Math.max(dur - pos, 1000), 15000); }   // not one of yours: just watch
    const segs = playSegs(t, dur);
    const inPart = i => pos >= segs[i].start - 400 && pos < segs[i].end;
    let k = run.cur?.uri === uri ? run.cur.idx : -1;
    if (k < 0 || k >= segs.length) {
      // this song has just started: go to its first part
      if (!inPart(0)) return this.seekTo(run, uri, 0, segs[0].start);
      k = 0;
    } else if (!inPart(k)) {
      const j = segs.findIndex((s, i) => pos >= s.start - 400 && pos < s.end);
      if (j >= 0) k = j;                                 // you moved into another part yourself
      else return this.jump(run, uri, segs, k, st, lib);   // in a cut-out bit: on to the next part
    }
    run.cur = { uri, idx: k };
    const lead = run.lead ?? DEFAULT_LEAD, remaining = segs[k].end - pos;
    if (remaining <= lead) return this.jump(run, uri, segs, k, st, lib);
    return Math.min(remaining - lead, 15000);            // wake up just in time for the next jump
  }
  async jump(run, uri, segs, k, st, lib) {
    if (k + 1 < segs.length) return this.seekTo(run, uri, k + 1, segs[k + 1].start);
    return this.nextSong(run, uri, st, lib);
  }
  async seekTo(run, uri, idx, ms) {
    await this.sp('PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(ms))}`);
    run.cur = { uri, idx }; run.expect = { uri, pos: ms, until: Date.now() + 3000 };
    return 700;
  }
  async nextSong(run, uri, st, lib) {
    const list = run.list || [], i = list.indexOf(uri);
    if (i >= 0 && !st.context) {
      // SongSnip started this list: go straight to the next song's first part, without hearing its intro
      let n = i + 1;
      if (n >= list.length) {
        if (!run.loop) { await this.sp('PUT', '/me/player/pause'); run.active = false; await this.log('finished the list'); return 1000; }
        n = 0;
      }
      const nu = list[n], nt = lib[nu], start = nt ? playSegs(nt, nt.dur)[0].start : 0;
      await this.sp('PUT', '/me/player/play', { uris: list, offset: { position: n }, position_ms: Math.round(start) });
      run.cur = { uri: nu, idx: 0 }; run.expect = { uri: nu, pos: start, until: Date.now() + 5000 };
      return 900;
    }
    // playing from a Spotify playlist/album: let Spotify move on, then jump to the first part when it starts
    await this.sp('POST', '/me/player/next');
    run.cur = null; run.expect = null;
    return 700;
  }
}
