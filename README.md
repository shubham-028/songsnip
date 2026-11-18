# SongSnip

Keep only the parts of a song you love. SongSnip saves the start and end times of your
favourite parts and controls the official Spotify and YouTube players so they skip the rest.
It doesn't download, copy or change any audio.

## Open it
**https://shubham-028.github.io/songsnip/**

That's all: no install. Updates appear when you refresh the page.

You can also run it on your own computer: `./start.sh` (Mac/Linux) or double-click `start.bat` (Windows),
which needs Python 3, then open http://127.0.0.1:8888/. Each address keeps its own songs, so use
**Export** / **Import** to move them between the two.

## Connect Spotify (one-time, needs Premium)
1. Go to https://developer.spotify.com/dashboard and click **Create app**.
2. Add the redirect URI `https://shubham-028.github.io/songsnip/` (and `http://127.0.0.1:8888/` if you
   also run it locally). It must match exactly, including the slash at the end.
3. Tick **Web API** and **Web Playback SDK**.
4. In the app's **User Management**, add your Spotify account's email address.
5. Paste the Client ID into SongSnip → ⚙ Settings → **Save & connect**.

## YouTube
Paste any YouTube or YouTube Music link. You don't need an account. While a YouTube song plays,
its video shows in a card on the page, because YouTube requires the video to stay visible.
Click **▁ Minimize** to shrink the video to a small box in the corner (200 × 200 is the smallest
YouTube allows), and click ⤢ to make it big again.
Spotify and YouTube songs can be mixed in the same list.

## Using it
- Add a song (search Spotify, or paste a Spotify or YouTube link). The trimmer opens and the song starts playing.
- Press `[` where a part you like begins and `]` where it ends. Do this for every part you want.
  The parts play one after another as a single track. Use ↑ ↓ to change their order.
- Fine-tune by dragging the green handles or typing times like `1:23.5`.
- **Play all snips** plays only the parts you kept, song after song, with optional smooth joins.
- Shortcuts: Space = play/pause, ←/→ = 5 seconds back/forward, N = next song, Esc = close the trimmer.

## Seamless joins (beat)
Spotify and YouTube don't let apps read a song's beat, so you give it once by tapping:
1. In the trimmer, while the song plays, press `T` on every beat for a few seconds, starting on a "1".
   SongSnip works out the tempo (BPM) and draws bar lines on the timeline.
2. Click **✨ Make perfect joins** to move every part's start and end onto a bar line, so the beat carries
   on into the next part. New parts and dragged handles snap to bars too (hold Alt to place freely).
   If the lines sit on the wrong beat, use **Shift bar line**, or **½× / 2×** if the tempo is half or double.
3. In the song list, **✨ Smart order** arranges songs so the tempo flows from one to the next. Songs with a
   beat fade out over 2 beats and fade in over 1 beat.
4. If joins sound slightly late or early, adjust **Join timing** in ⚙ Settings.

## Blend 🔀
Like Apple Music, each song fades out while the next one fades in (6 seconds by default; change it in
⚙ Settings, or turn it off with **🔀 Blend** in the song list). Only the parts you kept are blended.
- With a YouTube song on either side, the two songs overlap fully. YouTube → YouTube briefly shows both videos.
- Spotify plays only one song per account at a time, so two Spotify songs can't overlap. The first fades
  out, and the next starts loading early and fades in, so the gap is as short as possible.
- The parts of one song blend into each other too (2 seconds by default; "Blend between parts" in ⚙ Settings).
  On YouTube songs the two parts overlap and crossfade, lined up on the beat when a beat is set. On Spotify
  songs the part fades out and the next fades in. Untick "Blend between parts" in a song's trimmer to turn
  it off for that song.

Your snips are saved in your browser. Use **Export** to make a backup or to move them to another computer.
