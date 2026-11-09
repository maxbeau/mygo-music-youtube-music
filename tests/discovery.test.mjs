import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
async function plugin(answer, storage = new Map()) {
  const requests = [];
  const context = vm.createContext({
    host: { t: x => x, language: () => 'en', storage: { get: k => structuredClone(storage.get(k)), set: (k, v) => storage.set(k, structuredClone(v)), remove: k => storage.delete(k) } },
    URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout, console,
    fetch: async (url, options) => {
      const endpoint = url.split('/youtubei/v1/')[1]?.split('?')[0];
      const body = JSON.parse(options.body); delete body.context;
      requests.push({ endpoint, body });
      const result = await answer(endpoint, body, requests);
      return { ok: true, status: 200, json: async () => result };
    },
  });
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(() => { throw new Error('unexpected import'); });
  await mod.evaluate();
  return { api: mod.namespace, requests, storage };
}
const panel = (ids, token, automix) => ({ playlistPanelRenderer: {
  contents: [...ids.map(videoId => ({ playlistPanelVideoRenderer: { videoId, title: { simpleText: videoId }, lengthText: { simpleText: '3:00' } } })),
    ...(automix ? [{ automixPreviewVideoRenderer: { content: { automixPlaylistVideoRenderer: { navigationEndpoint: { watchPlaylistEndpoint: automix } } } } }] : [])],
  continuations: token ? [{ nextContinuationData: { continuation: token } }] : [],
} });
const row = (id, setVideoId) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId: id, playlistSetVideoId: setVideoId },
  flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: id }] } } }],
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { simpleText: '3:00' } } }],
} });
const playlist = entries => ({ musicPlaylistShelfRenderer: { contents: entries.map(([id, set]) => row(id, set)) } });
const signedIn = () => new Map([['cookie', 'SAPISID=test-only']]);

// Starting a seeded radio keeps its seed and continuation when another song is reported.
test('radio follows continuation and deduplicates across batches', async () => {
  const p = await plugin((_, b) => b.continuation ? panel(['b', 'c']) : panel(['seed', 'a', 'b'], 'page-2'));
  const station = await p.api.radio({ kind: 'track', id: 'seed' });
  assert.equal(station.public, true);
  assert.deepEqual(plain(await p.api.stationNext({ id: station.id })).map(t => t.id), ['a', 'b']);
  await p.api.played({ id: 'unrelated' });
  assert.deepEqual(plain(await p.api.stationNext({ id: station.id })).map(t => t.id), ['c']);
  assert.equal(p.requests[1].body.continuation, 'page-2');
  assert.equal(p.requests[1].body.videoId, 'seed');
  assert.deepEqual(plain(await p.api.stationNext({ id: station.id })), []);
  assert.equal(p.requests.length, 2);
});

// Restoring a station resumes its persisted page rather than reseeding from lastPlayed.
test('radio session survives a plugin restart', async () => {
  const storage = new Map();
  const p = await plugin(() => panel(['seed', 'a'], 'resume'), storage);
  const station = await p.api.radio({ kind: 'track', id: 'seed' });
  await p.api.stationNext({ id: station.id });
  const next = await plugin(() => panel(['b']), storage);
  await next.api.stationNext({ id: station.id });
  assert.equal(next.requests[0].body.continuation, 'resume');
});

// AutoMix endpoints carry their params into the next request.
test('radio follows AutoMix and artist button endpoints', async () => {
  const endpoint = { playlistId: 'RDARTIST', videoId: 'first', params: 'artist-params', index: 0 };
  const p = await plugin((e, b) => e === 'browse' ? { musicImmersiveHeaderRenderer: { title: { simpleText: 'Singer' }, startRadioButton: { buttonRenderer: { navigationEndpoint: { watchEndpoint: endpoint } } } } } : b.playlistId === 'RDARTIST' ? panel(['a', 'b'], null, { playlistId: 'mix', params: 'mix-params' }) : panel(['c']));
  const station = await p.api.radio({ kind: 'artist', id: 'UCsinger' });
  await p.api.stationNext({ id: station.id });
  await p.api.stationNext({ id: station.id });
  assert.equal(p.requests[1].body.params, 'artist-params');
  assert.equal(p.requests[2].body.playlistId, 'mix');
  assert.equal(p.requests[2].body.params, 'mix-params');
});

// Failed requests leave the saved continuation intact for a later retry.
test('radio retries transient failures without consuming continuation', async () => {
  let fail = false;
  const p = await plugin((_, b) => { if (fail) throw new Error('offline'); return b.continuation ? panel(['c']) : panel(['seed', 'a'], 'next'); });
  const st = await p.api.radio({ kind: 'track', id: 'seed' });
  await p.api.stationNext({ id: st.id });
  fail = true;
  await assert.rejects(p.api.stationNext({ id: st.id }), /offline/);
  fail = false;
  await p.api.stationNext({ id: st.id });
  assert.equal(p.requests.at(-1).body.continuation, 'next');
});

// An empty explicit RD playlist falls back to YouTube's video-only endpoint.
test('radio falls back when RDAMVM returns only the seed', async () => {
  const p = await plugin((_, b) => b.playlistId ? panel(['seed']) : panel(['seed', 'a']));
  const st = await p.api.radio({ kind: 'track', id: 'seed' });
  assert.equal((await p.api.stationNext({ id: st.id }))[0].id, 'a');
  assert.equal(p.requests[1].body.playlistId, undefined);
});

// Concurrent refill requests advance a station serially rather than repeating its page.
test('radio serializes refills and isolates different stations', async () => {
  const p = await plugin((_, b) => b.continuation ? panel([`${b.videoId}-b`]) : panel([b.videoId, `${b.videoId}-a`], 'second'));
  const a = await p.api.radio({ kind: 'track', id: 'a' });
  const b = await p.api.radio({ kind: 'track', id: 'b' });
  const batches = await Promise.all([p.api.stationNext({ id: a.id }), p.api.stationNext({ id: a.id }), p.api.stationNext({ id: b.id })]);
  assert.deepEqual(plain(batches).map(x => x.map(t => t.id)), [['a-a'], ['a-b'], ['b-a']]);
});

// Mood navigation keeps browse params and can be reopened without an in-memory registry.
test('mood category links preserve params', async () => {
  const p = await plugin((_, b) => b.browseId === 'FEmusic_moods_and_genres' ? { musicNavigationButtonRenderer: { buttonText: { simpleText: 'Focus' }, clickCommand: { browseEndpoint: { browseId: 'mood', params: 'focus' } } } } : { gridRenderer: { items: [] } });
  const page = await p.api.browse({ page: 'moods' });
  await p.api.browse({ page: page.sections[0].links[0].page });
  assert.deepEqual(p.requests[1].body, { browseId: 'mood', params: 'focus' });
});

// A full artist page preserves groups, all initial tracks, and the See All endpoint.
test('artist discography is not truncated to twenty tracks', async () => {
  const p = await plugin(() => ({ musicImmersiveHeaderRenderer: { title: { simpleText: 'Singer' } }, sectionListRenderer: { contents: [{ musicShelfRenderer: { title: { runs: [{ text: 'Songs' }] }, contents: Array.from({ length: 25 }, (_, i) => row(String(i), String(i))), bottomEndpoint: { browseEndpoint: { browseId: 'all', params: 'songs' } } } }] } }));
  const page = await p.api.artist({ id: 'artist' });
  assert.equal(page.tracks.length, 25);
  assert.equal(page.sections[0].tracks.length, 25);
  assert.ok(page.sections[0].morePage.includes('songs'));
});

// A home Mix stays a playable station instead of becoming a single ordinary song.
test('Mix cards and shelf pagination are preserved', async () => {
  const p = await plugin(() => ({ sectionListRenderer: { contents: [{ musicCarouselShelfRenderer: { title: { simpleText: 'Mixes' }, contents: [{ musicTwoRowItemRenderer: { title: { simpleText: 'My Mix' }, navigationEndpoint: { watchPlaylistEndpoint: { playlistId: 'RDmix', params: 'mix' } } } }], continuations: [{ nextContinuationData: { continuation: 'more' } }] } }] } }));
  const page = await p.api.home();
  assert.equal(page.sections[0].stations[0].public, true);
  assert.ok(page.sections[0].morePage);
});

// Related browsing uses its dedicated tab and propagates the browse params.
test('related music follows the related tab', async () => {
  const p = await plugin(e => e === 'next' ? { watchNextTabbedResultsRenderer: { tabs: [{}, {}, { tabRenderer: { endpoint: { browseEndpoint: { browseId: 'MPTRrelated', params: 'related' } } } }] } } : { musicShelfRenderer: { contents: [row('related', 'set')] } });
  const page = await p.api.related({ id: 'seed' });
  assert.equal(page.sections[0].tracks[0].id, 'related');
  assert.equal(p.requests[1].body.params, 'related');
});

// All cloud writes require a session before sending any request.
test('cloud mutations refuse signed-out writes', async () => {
  const p = await plugin(() => { throw new Error('network must not be reached'); });
  for (const [name, args] of [['createPlaylist', { name: 'a' }], ['saveAlbum', { id: 'album', on: true }], ['savePlaylist', { id: 'p', on: true }], ['followArtist', { id: 'UCa', on: true }], ['addToPlaylist', { id: 'p', trackIds: ['a'] }]]) {
    await assert.rejects(p.api[name](args), e => e.code === 'signIn');
  }
  assert.equal(p.requests.length, 0);
});

// Cloud actions target the album playlist and artist channel, not their browse IDs.
test('album save, artist follow and playlist writes use service identifiers', async () => {
  const p = await plugin((e, b) => e !== 'browse' ? e === 'playlist/create' ? { playlistId: 'new' } : { status: 'STATUS_SUCCEEDED' } : b.browseId === 'album' ? { likeEndpoint: { target: { playlistId: 'OLAKalbum' } } } : { subscribeButtonRenderer: { channelId: 'UCchannel' } }, signedIn());
  await p.api.saveAlbum({ id: 'album', on: true });
  await p.api.followArtist({ id: 'artist-browse', on: false });
  const created = await p.api.createPlaylist({ name: 'New' });
  await p.api.renamePlaylist({ id: 'new', name: 'Renamed' });
  await p.api.addToPlaylist({ id: 'new', trackIds: ['a', 'b'] });
  await p.api.deletePlaylist({ id: 'new' });
  assert.equal(created.mine, true);
  assert.deepEqual(p.requests.find(r => r.endpoint === 'like/like').body.target, { playlistId: 'OLAKalbum' });
  assert.deepEqual(p.requests.find(r => r.endpoint === 'subscription/unsubscribe').body.channelIds, ['UCchannel']);
  assert.equal(p.requests.find(r => r.endpoint === 'playlist/create').body.privacyStatus, 'PRIVATE');
  assert.equal(p.requests.filter(r => r.endpoint === 'browse/edit_playlist').length, 2);
});

// Removing a repeated video removes each occurrence ID, matching MyGO's ID-based removal.
test('playlist removal uses every duplicate occurrence ID', async () => {
  const p = await plugin(e => e === 'browse' ? playlist([['a', 'one'], ['b', 'two'], ['a', 'three']]) : { status: 'STATUS_SUCCEEDED' }, signedIn());
  await p.api.removeFromPlaylist({ id: 'p', trackIds: ['a'] });
  const actions = p.requests.at(-1).body.actions;
  assert.deepEqual(actions.map(a => a.setVideoId), ['one', 'three']);
  assert.ok(actions.every(a => a.removedVideoId === 'a'));
});

// Index-based moving uses the selected occurrence and its successor after the move.
test('playlist reorder preserves duplicate songs and moves to end', async () => {
  const p = await plugin(e => e === 'browse' ? playlist([['a', 'one'], ['b', 'two'], ['a', 'three']]) : { status: 'STATUS_SUCCEEDED' }, signedIn());
  await p.api.playlist({ id: 'p' });
  await p.api.movePlaylistTrack({ id: 'p', from: 2, to: 1 });
  assert.deepEqual(p.requests.at(-1).body.actions[0], { action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: 'three', movedSetVideoIdSuccessor: 'two' });
  const q = await plugin(e => e === 'browse' ? playlist([['a', 'one'], ['b', 'two'], ['a', 'three']]) : {}, signedIn());
  await q.api.movePlaylistTrack({ id: 'p', from: 0, to: 2 });
  assert.equal(q.requests.at(-1).body.actions[0].movedSetVideoIdSuccessor, null);
});

// A playlist changed elsewhere is rejected instead of moving the wrong index.
test('playlist reorder detects external edits', async () => {
  let rows = [['a', 'one'], ['b', 'two']];
  const p = await plugin(() => playlist(rows), signedIn());
  await p.api.playlist({ id: 'p' });
  rows = [['b', 'two'], ['a', 'one']];
  await assert.rejects(p.api.movePlaylistTrack({ id: 'p', from: 0, to: 1 }), /Reload/);
  assert.ok(p.requests.every(r => r.endpoint === 'browse'));
});

// Failed mutations are surfaced, not treated as an optimistic local success.
test('mutation errors reach the host', async () => {
  const p = await plugin(() => ({ status: 'STATUS_FAILED' }), signedIn());
  await assert.rejects(p.api.renamePlaylist({ id: 'p', name: 'Name' }), /refused/);
});

// Missing occurrence IDs block destructive edits rather than guessing by video ID.
test('playlist edits refuse missing occurrence IDs', async () => {
  const p = await plugin(() => playlist([['a', undefined]]), signedIn());
  await assert.rejects(p.api.removeFromPlaylist({ id: 'p', trackIds: ['a'] }), /Reload/);
  assert.equal(p.requests.length, 1);
});

// Library grids keep ownership and continuation when listing playlists and albums.
test('cloud library preserves owned playlists and saved album pages', async () => {
  const card=(id, type, mine=false)=>({musicTwoRowItemRenderer:{title:{simpleText:id},navigationEndpoint:{browseEndpoint:{browseId:id,browseEndpointContextSupportedConfigs:{browseEndpointContextMusicConfig:{pageType:type}}}},...(mine?{menu:{playlistEditorEndpoint:{playlistId:id}}}:{})}});
  const p=await plugin((_,b)=> b.browseId==='FEmusic_liked_playlists'?{gridRenderer:{items:[card('VLmine','MUSIC_PAGE_TYPE_PLAYLIST',true),card('VLsaved','MUSIC_PAGE_TYPE_PLAYLIST')]}}:{gridRenderer:{items:[card(b.continuation?'album2':'album1','MUSIC_PAGE_TYPE_ALBUM')],continuations:b.continuation?[]:[{nextContinuationData:{continuation:'albums2'}}]}},signedIn());
  const playlists=await p.api.playlists();
  assert.equal(playlists[0].mine,true);
  assert.equal(playlists[1].saved,true);
  const first=await p.api.savedAlbums({offset:0});
  assert.equal(first.more,true);
  const second=await p.api.savedAlbums({offset:first.albums.length});
  assert.equal(second.albums[0].id,'album2');
  assert.equal(second.more,false);
});

// Repeated continuation tokens never allow edits against a partial playlist.
test('playlist pagination detects loops before destructive edits', async () => {
  const p=await plugin(()=>({musicPlaylistShelfRenderer:{contents:[row('a','one')],continuations:[{nextContinuationData:{continuation:'loop'}}]}}),signedIn());
  await assert.rejects(p.api.removeFromPlaylist({id:'p',trackIds:['a']}),/too large/);
  assert.ok(p.requests.every(r=>r.endpoint==='browse'));
});

// Signing out during an in-flight radio response cannot save the old account's queue.
test('sign out discards pending radio sessions', async () => {
  let release;
  const started=new Promise(resolve=>{release=resolve;});
  let enter;
  const entered=new Promise(resolve=>{enter=resolve;});
  const p=await plugin(async()=>{enter();await started;return panel(['seed','a'],'next');},signedIn());
  const st=await p.api.radio({kind:'track',id:'seed'});
  const loading=p.api.stationNext({id:st.id});
  await entered;
  p.api.signOut();
  release();
  assert.deepEqual(plain(await loading),[]);
  assert.equal(p.storage.has('radioSessions'),false);
});

// Live YouTube radio uses nextRadioContinuationData, unlike browse's nextContinuationData.
test('radio recognizes the live radio continuation variant', async () => {
  const p=await plugin((_,b)=>{
    if(b.continuation) return panel(['second-page']);
    const r=panel(['seed','first-page']);
    r.playlistPanelRenderer.continuations=[{nextRadioContinuationData:{continuation:'radio-page-2'}}];
    return r;
  });
  const st=await p.api.radio({kind:'track',id:'seed'});
  await p.api.stationNext({id:st.id});
  const next=await p.api.stationNext({id:st.id});
  assert.equal(next[0].id,'second-page');
  assert.equal(p.requests[1].body.continuation,'radio-page-2');
});
