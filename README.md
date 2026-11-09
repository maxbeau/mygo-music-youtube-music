# YouTube Music for MyGo Music

Plays YouTube Music in [MyGo Music](https://github.com/egoist/mygo-music). It isn't affiliated with or endorsed by YouTube or Google, uses YouTube's private API, and may stop working at any time.

## Install

Install [ffmpeg](https://ffmpeg.org), and [yt-dlp](https://github.com/yt-dlp/yt-dlp) as a fallback. On macOS:

```bash
brew install ffmpeg yt-dlp
```

yt-dlp needs a JavaScript runtime (Deno, Node or Bun) to solve YouTube's challenges; Homebrew includes Deno. Keep yt-dlp up to date, as YouTube changes often.

Install with the deeplink:

[mygo-music://install-plugin?repo=egoist/mygo-music-youtube-music](mygo-music://install-plugin?repo=egoist/mygo-music-youtube-music)

Or paste the GitHub URL in Settings > Plugins:

[https://github.com/egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music)

In Settings > Plugins, allow YouTube Music to start programs. To get your library, click **Sign In** and sign in to Google in the window that opens.

This version needs MyGo Music 0.1.23 or later, and only starts ffmpeg and yt-dlp: from the PATH, `/opt/homebrew/bin` or `/usr/local/bin`. If they're somewhere else, link them into one of those.

## Signing in

You sign in on Google's page, in a window of the app. The session is kept unencrypted in the plugin's data on this machine, and is sent to music.youtube.com, s.youtube.com for your history, and to yt-dlp when it fetches audio. Signing out forgets it. To end the session on Google's side, remove the device in your Google account's security settings.

## What works

- Signed out: playing, Home and Mix cards, charts, new releases, moods and genres, search, full artist sections with See All links, related music, song/artist radio, albums, playlists and timed lyrics.
- Signed in: your library, liked songs, recently played, a personal Home, listening history, following artists, saving albums and playlists, and creating, renaming, deleting and editing playlists.
- Not available: podcasts and comments.

## How it plays

Tracks are fetched the way YouTube's Vision Pro app fetches them, then ffmpeg converts them to MP3 on the fly. If that fails, yt-dlp is used instead; it can take up to 15 seconds to start, and needs you signed in from a VPN or server network. The audio is lossy.

## Lyrics

From [Better Lyrics](https://github.com/better-lyrics/better-lyrics) when available, otherwise from YouTube Music.

## Radio and discovery

Use **Start Song Radio** or **Related Music** in a song's menu, or **Start Artist Radio** on an artist page. Each radio keeps its own endpoint, continuation and recent IDs; AutoMix endpoints are followed without reseeding from every played song. The last twelve radio sessions are stored for queue restoration. Signing out clears those sessions.

MyGo's **Settings > Playback > Autoplay Related Music** continues a naturally completed queue when enabled. It is off by default, yields to repeat, and does not continue podcast episodes. New playback requests and seeking cancel stale recommendations; pausing while loading stays paused.

Artist sections keep the service's original groups and **See All** links. **Moods & Genres** and **Following** are in the sidebar. Home and browse pages retain pagination links instead of silently truncating the catalog.

## Playlist editing

New playlists are private. Removal follows MyGo's current contract: removing a song ID removes all occurrences of that ID from the playlist. Reordering preserves the selected occurrence using its playlist item ID. The plugin reads all playlist pages before a destructive edit, rejects missing occurrence IDs and repeated pagination tokens, and refuses a reorder if the server order has changed since the last load. Reload the playlist after such an error. Playlists requiring more than 31 pages are rejected rather than edited from an incomplete list.

## Development

Run the fixture tests with Node 22 or later:

```bash
node --experimental-vm-modules --test tests/discovery.test.mjs
```

Tests intercept network calls and never edit a real account. The companion MyGo checkout also has an opt-in test that executes this exact plugin in its real JavaScript engine:

```bash
YOUTUBE_PLUGIN_DIR=/absolute/path/to/this/plugin go test ./internal/plugin -run TestYouTubePluginRuntime -v
```

The request shapes were checked against the Metrolist/InnerTubeX implementations. Live checks cover anonymous discovery and radio; account writes still need acceptance with a signed-in test account.
