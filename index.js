// YouTube Music, for personal use. The catalog comes from the API its website
// calls. A track's audio is found as YouTube's app for the Vision Pro asks for
// it, which is given addresses that play as they are, and ffmpeg turns it into
// an MP3 stream, keeping the plugin's existing playback path across formats.
// Should YouTube stop answering that app, yt-dlp finds the audio instead, if
// it's installed. Your library takes your own session, which signing in on
// Google's page in a window of the app gives, as its cookies.

const site = "https://music.youtube.com";
const webUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// What the plugin says is in the listener's language, from locales/zh-CN.json.
const t = host.t;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The session's cookies, as a Cookie header, kept in the plugin's storage.
const cookie = () => host.storage.get("cookie") || "";

function cookieValue(name) {
  for (const part of cookie().split(";")) {
    const at = part.indexOf("=");
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

function needAccount() {
  if (!cookie()) throw fail("signIn");
}

function sha1(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let at = 0; at < bytes.length; at += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[at + i * 4] << 24) | (bytes[at + i * 4 + 1] << 16) | (bytes[at + i * 4 + 2] << 8) | bytes[at + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
    }
    [a, b, c, d, e].forEach((v, i) => (h[i] = (h[i] + v) | 0));
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

// What the website sends to say whose session this is, to the site at origin.
function authHeaders(origin = site) {
  const sapisid = cookieValue("__Secure-3PAPISID") || cookieValue("SAPISID");
  if (!sapisid) return {};
  const now = Math.floor(Date.now() / 1000);
  return {
    cookie: cookie(),
    authorization: `SAPISIDHASH ${now}_${sha1(`${now} ${sapisid} ${origin}`)}`,
    "x-goog-authuser": "0",
  };
}

function clientVersion() {
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `1.${d}.01.00`;
}

// The apps the service tells apart, as a request says it's from one of them.
const remix = {
  get client() {
    // YouTube's own titles, such as its shelves', come in the listener's language.
    return { clientName: "WEB_REMIX", clientVersion: clientVersion(), hl: host.language() === "zh-CN" ? "zh-CN" : "en" };
  },
};

// Its Android app, which is told when each line of the lyrics is sung, where
// the website only gets the words.
const android = {
  client: { clientName: "ANDROID_MUSIC", clientVersion: "7.21.50", androidSdkVersion: 34 },
  headers: { "user-agent": "com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 14) gzip" },
};

// YouTube's app for the Vision Pro, which is given audio at addresses that need
// no signature worked out, nor YouTube's JavaScript run. It asks as a visitor:
// a session is turned down.
const visionUA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const visionOS = (visitor) => ({
  client: {
    clientName: "VISIONOS",
    clientVersion: "1.02",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    userAgent: visionUA,
    osName: "visionOS",
    osVersion: "26.5.23O471",
    visitorData: visitor,
  },
  headers: {
    "user-agent": visionUA,
    "x-goog-visitor-id": visitor,
    "x-youtube-client-name": "101",
    "x-youtube-client-version": "1.02",
  },
  anonymous: true,
});

// call asks the service as the website, or as another of its apps. An
// anonymous call leaves the session out.
async function call(endpoint, body, as = remix, signal) {
  const res = await fetch(`${site}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "user-agent": webUA,
      origin: site,
      "x-origin": site,
      ...(as.anonymous ? {} : authHeaders()),
      ...as.headers,
    },
    body: JSON.stringify({ context: { client: as.client }, ...body }),
  });
  if (res.status === 401) {
    endSession();
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  }
  if (!res.ok) { const error = new Error(`${endpoint}: ${res.status}`); error.status = res.status; throw error; }
  return res.json();
}

const browseId = (id) => call("browse", { browseId: id });

// Keep navigation parameters, not just browseId: artist discographies and
// mood pages often share an ID and differ only by params.
const browsePageId = (endpoint, title = "") => `yt:${encodeURIComponent(JSON.stringify({ ...endpoint, title }))}`;

function watchOf(nav) {
  const w = nav?.watchEndpoint || nav?.watchPlaylistEndpoint;
  if (!w) return null;
  const out = {};
  for (const key of ["videoId", "playlistId", "playlistSetVideoId", "index", "params"]) {
    if (w[key] !== undefined) out[key] = w[key];
  }
  return out.videoId || out.playlistId ? out : null;
}

function stationFor(endpoint, name, imageUrl) {
  // The endpoint in the ID lets a restored queue recover even if its stored
  // continuation expired. Different starts have independent sessions.
  return { id: `yt-radio:${encodeURIComponent(JSON.stringify({ endpoint, session: playbackNonce() }))}`, name, imageUrl, public: true };
}

// Answers are deep and change shape, so what's in them is found by name.

function findAll(node, name, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, name, out);
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === name) out.push(node[key]);
      else findAll(node[key], name, out);
    }
  }
  return out;
}
const findOne = (node, name) => findAll(node, name)[0];

const textOf = (t) => (t ? t.simpleText || (t.runs || []).map((r) => r.text).join("") : "");

// Covers come in the size asked for in their address.
function imageOf(node) {
  const list = node && findOne(node, "thumbnails");
  const url = list && list.length ? list[list.length - 1].url : "";
  if (!url) return undefined;
  return url.replace(/=w\d+-h\d+[^/]*$/, "=w544-h544-l90-rj");
}

function msOf(text) {
  if (!text || !/^\d+(:\d+)+$/.test(text)) return 0;
  return text.split(":").reduce((sum, n) => sum * 60 + Number(n), 0) * 1000;
}

const pageTypeOf = (nav) =>
  nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || "";

const plainPlaylistId = (id) => (id || "").replace(/^VL/, "");

// What a line of credits names: who, on which album, and for how long.
function creditsOf(runs) {
  const out = { artists: [], album: null, duration: 0, names: [] };
  for (const run of runs || []) {
    const text = run.text;
    if (!text || /^\s*[•·,&]\s*$/.test(text)) continue;
    const nav = run.navigationEndpoint;
    const type = pageTypeOf(nav);
    if (type === "MUSIC_PAGE_TYPE_ARTIST" || type === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
      out.artists.push({ id: nav.browseEndpoint.browseId, name: text });
    } else if (type === "MUSIC_PAGE_TYPE_ALBUM" || type === "MUSIC_PAGE_TYPE_AUDIOBOOK") {
      out.album = { id: nav.browseEndpoint.browseId, name: text };
    } else if (msOf(text)) {
      out.duration = msOf(text);
    } else {
      out.names.push(text);
    }
  }
  return out;
}

function trackFrom(id, name, credits, image, unavailable) {
  // A track whose artist has no page of their own only has them as words, the
  // first of which may be its kind in a list of everything.
  const artists = credits.artists.length
    ? credits.artists
    : credits.names.slice(0, 1).map((n) => ({ id: "", name: n }));
  return {
    id,
    name,
    artists,
    album: credits.album ? { ...credits.album, imageUrl: image } : { id: "", name: "", imageUrl: image },
    duration: credits.duration,
    url: `${site}/watch?v=${id}`,
    unavailable: unavailable || undefined,
  };
}

// A row of a list: a song, or what a search for other things finds.
function rowOf(r) {
  const columns = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
  const name = textOf(columns[0]);
  const nav = columns[0]?.runs?.[0]?.navigationEndpoint;
  const videoId = r.playlistItemData?.videoId || nav?.watchEndpoint?.videoId;
  const runs = columns.slice(1).flatMap((c) => [...(c?.runs || []), { text: "•" }]);
  const fixed = (r.fixedColumns || []).map((c) => textOf(c.musicResponsiveListItemFixedColumnRenderer?.text));
  const credits = creditsOf(runs);
  credits.duration = credits.duration || msOf(fixed[0]);
  const image = imageOf(r.thumbnail);
  if (videoId) {
    const grey = r.musicItemRendererDisplayPolicy === "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";
    return { kind: "track", value: { ...trackFrom(videoId, name, credits, image, grey), playlistItemId: r.playlistItemData?.playlistSetVideoId || findOne(r.menu, "playlistEditEndpoint")?.actions?.find((a) => a.setVideoId)?.setVideoId } };
  }
  const target = r.navigationEndpoint;
  const got = collectionOf(target, name, runs, image);
  if (got?.kind === "playlist") got.value.mine = Boolean(findOne(r.menu, "playlistEditEndpoint") || findOne(r.menu, "playlistEditorEndpoint"));
  return got;
}

// A card: anything at all, by where it leads.
function cardOf(r) {
  const name = textOf(r.title);
  const runs = r.subtitle?.runs || [];
  const image = imageOf(r.thumbnailRenderer);
  const nav = r.navigationEndpoint;
  const watch = watchOf(nav);
  if (watch?.playlistId && (nav?.watchPlaylistEndpoint || !watch.videoId)) return { kind: "station", value: stationFor(watch, name, image) };
  if (nav?.watchEndpoint?.videoId) {
    const credits = creditsOf(runs);
    // On a card, words come first that say what it is.
    credits.names = credits.names.slice(1);
    return { kind: "track", value: trackFrom(nav.watchEndpoint.videoId, name, credits, image) };
  }
  const got = collectionOf(nav, name, runs, image);
  if (got?.kind === "playlist") got.value.mine = Boolean(findOne(r.menu, "playlistEditEndpoint") || findOne(r.menu, "playlistEditorEndpoint"));
  return got;
}

function collectionOf(nav, name, runs, image) {
  const id = nav?.browseEndpoint?.browseId;
  if (!id) return null;
  const credits = creditsOf(runs);
  switch (pageTypeOf(nav)) {
    case "MUSIC_PAGE_TYPE_ARTIST":
    case "MUSIC_PAGE_TYPE_USER_CHANNEL":
      return { kind: "artist", value: { id, name, imageUrl: image } };
    case "MUSIC_PAGE_TYPE_ALBUM":
    case "MUSIC_PAGE_TYPE_AUDIOBOOK":
      return { kind: "album", value: { id, name, imageUrl: image, artists: credits.artists, released: credits.names.find((n) => /^\d{4}$/.test(n)) } };
    case "MUSIC_PAGE_TYPE_PLAYLIST":
      return { kind: "playlist", value: { id: plainPlaylistId(id), name, imageUrl: image, owner: credits.artists[0]?.name || credits.names[1] || "" } };
  }
  return null;
}

function itemsOf(list) {
  const out = [];
  for (const item of list || []) {
    const row = item.musicResponsiveListItemRenderer;
    const card = item.musicTwoRowItemRenderer;
    const button = item.musicNavigationButtonRenderer;
    const endpoint = button?.clickCommand?.browseEndpoint;
    const got = row ? rowOf(row) : card ? cardOf(card) : endpoint ? {
      kind: "link", value: { title: textOf(button.buttonText), page: browsePageId(endpoint, textOf(button.buttonText)) },
    } : null;
    if (got) out.push(got);
  }
  return out;
}

const ofKind = (items, kind) => items.filter((i) => i.kind === kind).map((i) => i.value);

// Some lists leave out how long a song is, and the app needs that to seek and
// to know when it ends. The queue answers for many at once.
async function withDurations(tracks) {
  const missing = tracks.filter((t) => !t.duration).map((t) => t.id);
  if (!missing.length) return tracks;
  const known = {};
  try {
    const r = await call("music/get_queue", { videoIds: [...new Set(missing)].slice(0, 100) });
    for (const v of findAll(r, "playlistPanelVideoRenderer")) known[v.videoId] = msOf(textOf(v.lengthText));
  } catch (e) {
    console.warn(`get_queue: ${e.message}`);
  }
  for (const t of tracks) t.duration = t.duration || known[t.id] || 0;
  return tracks;
}

function shelfTitle(shelf) {
  return textOf(shelf.title) || textOf(findOne(shelf.header, "title"));
}

// The sections of a page of shelves, in their order.
async function sectionsOf(answer) {
  const sections = [];
  const shelves = [];
  const names = new Set(["musicCarouselShelfRenderer", "musicShelfRenderer", "musicPlaylistShelfRenderer", "gridRenderer",
    "gridContinuation", "musicShelfContinuation", "musicPlaylistShelfContinuation"]);
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (names.has(key)) shelves.push(value);
      else visit(value);
    }
  }
  visit(answer);
  const appended = findAll(answer, "appendContinuationItemsAction");
  for (const action of appended) shelves.push({ contents: action.continuationItems });
  for (const shelf of shelves) {
    const items = itemsOf(shelf.contents || shelf.items);
    const title = shelfTitle(shelf);
    const endpoint = shelf.bottomEndpoint?.browseEndpoint ||
      findOne(shelf.header, "browseEndpoint") || shelf.title?.runs?.find((r) => r.navigationEndpoint?.browseEndpoint)?.navigationEndpoint.browseEndpoint ||
      findOne(shelf.bottomText, "browseEndpoint");
    const token = nextToken(shelf);
    const section = {
      title,
      entries: items.map(({ kind, value }) => ({ [kind]: value })),
      tracks: await withDurations(ofKind(items, "track")),
      albums: ofKind(items, "album"), artists: ofKind(items, "artist"),
      playlists: ofKind(items, "playlist"), stations: ofKind(items, "station"), links: ofKind(items, "link"),
      morePage: endpoint ? browsePageId(endpoint, title) : token ? browsePageId({ continuation: token }, title) : undefined,
    };
    if (items.length || section.morePage) sections.push(section);
  }
  // Category buttons need not be in a shelf.
  if (!shelves.length) {
    const items = itemsOf(findAll(answer, "musicNavigationButtonRenderer").map((r) => ({ musicNavigationButtonRenderer: r })));
    if (items.length) sections.push({ links: ofKind(items, "link") });
  }
  return sections;
}

function pageSectionsMore(answer, sections, title) {
  const root = findOne(answer, "sectionListRenderer") || findOne(answer, "sectionListContinuation");
  const token = nextToken(root?.continuations);
  if (token) sections.push({ links: [{ title: t("More"), page: browsePageId({ continuation: token }, title) }] });
  return sections;
}

// A next page's token, in either of the ways it's given.
function nextToken(node) {
  if (!node) return "";
  const old = findOne(node, "nextContinuationData") || findOne(node, "nextRadioContinuationData");
  if (old?.continuation) return old.continuation;
  return findOne(node, "continuationCommand")?.token || "";
}

// The app asks for pages by how much it has, the service by a token: this is
// which token goes with how much.
const tokens = new Map();
function pageToken(key, offset) {
  return offset > 0 ? tokens.get(`${key}\0${offset}`) : null;
}
function keepToken(key, offset, token) {
  if (token) tokens.set(`${key}\0${offset}`, token);
  return Boolean(token);
}

// What a page's rows are, and its next token. Those of a next page aren't where
// the first page's are.
function rowsOf(answer) {
  const further = findOne(answer, "onResponseReceivedActions") || findOne(answer, "musicShelfContinuation") || findOne(answer, "musicPlaylistShelfContinuation");
  if (further) {
    const list = findAll(further, "continuationItems")[0] || further.contents || [];
    return { items: itemsOf(list), token: nextToken(further) };
  }
  const shelf = findOne(answer, "musicPlaylistShelfRenderer") || findOne(answer, "musicShelfRenderer");
  return { items: itemsOf(shelf?.contents), token: nextToken(shelf) };
}

// Account.

export async function account() {
  if (!cookie()) return null;
  const r = await call("account/account_menu", {});
  const header = findOne(r, "activeAccountHeaderRenderer");
  if (!header) return null;
  const name = textOf(header.accountName);
  return { id: textOf(header.channelHandle) || name, name, imageUrl: imageOf(header.accountPhoto) };
}

// Signing in is on Google's own page, as YouTube Music's website signs in, in a
// window the app shows. It's done once Google gives YouTube the session.
const signInPage =
  "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true" +
  "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F";

// Google turns down signing in on a page it takes for one inside an app, so it's
// told the page is the system's own browser.
const browserUA =
  host.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

export async function signIn() {
  const { cookie: session } = await host.webSignIn({
    url: signInPage,
    cookiesOf: site,
    until: ["SAPISID", "__Secure-3PSID"],
    userAgent: browserUA,
  });
  endSession();
  host.storage.set("cookie", session);
  likedSet = null;
  const me = await account();
  if (!me) {
    endSession();
    throw new Error(t("YouTube Music didn't take that sign-in: try again"));
  }
  return me;
}

export function signOut() {
  endSession();
}

// What's kept of a session goes with it.
function endSession() {
  host.storage.remove("cookie");
  likedSet = null;
  tokens.clear();
  stationStates.clear();
  sessionGeneration++;
  legacyStation = "";
  host.storage.remove("radioSessions");
  playlistRows.clear();
}

// Pages.

export async function home() {
  const answer = await browseId("FEmusic_home");
  return { title: t("Home"), layout: "discovery", sections: pageSectionsMore(answer, await sectionsOf(answer), t("Home")) };
}

export async function browse({ page }) {
  const ids = { charts: ["FEmusic_charts", "Charts"], new: ["FEmusic_new_releases", "New Releases"], moods: ["FEmusic_moods_and_genres", "Moods & Genres"], artists: ["FEmusic_library_corpus_artists", "Following"] };
  const known = ids[page];
  let request, title;
  if (known) {
    if (page === "artists") needAccount();
    [title, request] = [t(known[1]), { browseId: known[0] }];
  } else if (page.startsWith("yt:")) {
    const decoded = JSON.parse(decodeURIComponent(page.slice(3)));
    title = decoded.title || "";
    request = {};
    for (const key of ["browseId", "params", "continuation"]) if (typeof decoded[key] === "string") request[key] = decoded[key];
    if (!request.browseId && !request.continuation) throw fail("unavailable", t("no such page"));
  } else throw fail("unavailable", t("no such page"));
  const answer = await call("browse", request);
  return { title, sections: pageSectionsMore(answer, await sectionsOf(answer), title) };
}

export async function related({ id }) {
  const answer = await call("next", { videoId: id, isAudioOnly: true });
  const tabs = findOne(answer, "watchNextTabbedResultsRenderer")?.tabs || [];
  const endpoint = tabs.map((tab) => tab.tabRenderer?.endpoint?.browseEndpoint).find((e) => e?.browseId?.startsWith("MPTR")) ||
    tabs[2]?.tabRenderer?.endpoint?.browseEndpoint;
  if (!endpoint) return { title: t("Related Music"), sections: [] };
  const page = await call("browse", endpoint);
  return { title: t("Related Music"), sections: await sectionsOf(page) };
}

// Search. Each kind has its filter, which the website sends in this form.

const filters = {
  tracks: "EgWKAQIIAWoMEA4QChADEAQQCRAF",
  albums: "EgWKAQIYAWoMEA4QChADEAQQCRAF",
  artists: "EgWKAQIgAWoMEA4QChADEAQQCRAF",
  playlists: "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D",
};

export async function search({ query, kind, offset }) {
  const filter = filters[kind];
  if (!filter) return { [kind]: [], more: false };
  const key = `search\0${kind}\0${query}`;
  const token = pageToken(key, offset);
  if (offset > 0 && !token) return { [kind]: [], more: false };
  const answer = await call("search", token ? { continuation: token } : { query, params: decodeURIComponent(filter) });
  const { items, token: next } = rowsOf(answer);
  const single = { tracks: "track", albums: "album", artists: "artist", playlists: "playlist" }[kind];
  const found = ofKind(items, single);
  if (kind === "tracks") await withDurations(found);
  return { [kind]: found, more: keepToken(key, offset + found.length, next) };
}

export async function suggest({ query }) {
  const r = await call("music/get_search_suggestions", { input: query });
  return findAll(r, "searchSuggestionRenderer").map((s) => textOf(s.suggestion)).filter(Boolean);
}

// Albums and artists.

function librarySaved(answer) {
  const like = findOne(answer, "likeButtonRenderer");
  if (like) return like.likeStatus === "LIKE";
  const toggle = findAll(answer, "toggleButtonRenderer").find((b) => ["LIBRARY_ADD", "LIBRARY_SAVED"].includes(b.defaultIcon?.iconType));
  return Boolean(toggle?.isToggled || toggle?.defaultIcon?.iconType === "LIBRARY_SAVED");
}

function headerOf(answer) {
  return findOne(answer, "musicResponsiveHeaderRenderer") || findOne(answer, "musicDetailHeaderRenderer") || {};
}

async function albumPage({ id }) {
  const answer = await browseId(id);
  const header = headerOf(answer);
  const credits = creditsOf([...(header.straplineTextOne?.runs || []), ...(header.subtitle?.runs || [])]);
  const album = {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    artists: credits.artists,
    released: textOf(header.subtitle).match(/\b\d{4}\b/)?.[0],
    saved: librarySaved(answer),
  };
  const shelf = findOne(answer, "musicShelfRenderer");
  const tracks = ofKind(itemsOf(shelf?.contents), "track").map((t) => ({
    ...t,
    // An album's rows only name who's on them if that's someone else.
    artists: t.artists.length ? t.artists : album.artists,
    album: { id, name: album.name, imageUrl: album.imageUrl },
  }));
  return { album, tracks: await withDurations(tracks) };
}

async function artistPage({ id }) {
  const answer = await browseId(id);
  const header = findOne(answer, "musicImmersiveHeaderRenderer") || findOne(answer, "musicVisualHeaderRenderer") || {};
  const sections = await sectionsOf(answer);
  return {
    artist: { id, name: textOf(header.title), imageUrl: imageOf(header.thumbnail || header.foregroundThumbnail), following: Boolean(findOne(answer, "subscribeButtonRenderer")?.subscribed) },
    tracks: sections.flatMap((s) => s.tracks || []),
    albums: sections.flatMap((s) => s.albums || []),
    sections: pageSectionsMore(answer, sections, textOf(header.title)),
  };
}

export { albumPage as album, artistPage as artist };

// Playlists and the library.

// A long playlist comes in pages: this many is thousands of songs.
const pagesAtMost = 30;

async function playlistPage({ id }) {
  const answer = await browseId(`VL${id}`);
  const header = headerOf(answer);
  const tracks = await withDurations(await playlistTracks(answer));
  playlistRows.set(plainPlaylistId(id), tracks.map((r) => ({ id: r.id, setVideoId: r.playlistItemId })));
  return {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    description: textOf(findOne(header.description, "description") || header.description),
    owner: textOf(header.straplineTextOne),
    mine: Boolean(findOne(answer, "playlistEditEndpoint") || findOne(answer, "playlistEditorEndpoint") || findOne(answer, "musicEditablePlaylistDetailHeaderRenderer")),
    saved: librarySaved(answer),
    trackCount: tracks.length,
    tracks,
  };
}
export { playlistPage as playlist };

// The app loads this for its sidebar as it starts: no account is no playlists,
// rather than asking someone who's only browsing to sign in.
export async function playlists() {
  if (!cookie()) return [];
  const items = [];
  let answer = await browseId("FEmusic_liked_playlists");
  const seen = new Set();
  for (let page = 0; ; page++) {
    items.push(...(await sectionsOf(answer)).flatMap((s) => s.playlists || []));
    const token = nextToken(answer);
    if (!token) break;
    if (seen.has(token) || page >= pagesAtMost) throw new Error(t("The playlist is too large to edit safely"));
    seen.add(token);
    answer = await call("browse", { continuation: token });
  }
  // Liked Music has an entry of its own, and episodes for later aren't songs.
  return items.filter((p) => p.id !== "LM" && p.id !== "SE").map((p) => ({ ...p, saved: !p.mine }));
}

export async function liked({ offset }) {
  needAccount();
  const token = pageToken("liked", offset);
  if (offset > 0 && !token) return { tracks: [], more: false };
  const answer = token ? await call("browse", { continuation: token }) : await browseId("VLLM");
  const { items, token: next } = rowsOf(answer);
  const tracks = await withDurations(ofKind(items, "track"));
  return { tracks, more: keepToken("liked", offset + tracks.length, next) };
}

// The service can't say of many songs at once which are liked, so the first few
// pages of liked songs answer, for a few minutes at a time.
let likedSet = null;
let likedAt = 0;
const likedFor = 5 * 60 * 1000;

async function likedIds() {
  if (likedSet && Date.now() - likedAt < likedFor) return likedSet;
  const set = new Set();
  let { items, token } = rowsOf(await browseId("VLLM"));
  for (let i = 0; ; i++) {
    for (const t of ofKind(items, "track")) set.add(t.id);
    if (!token || i >= 5) break;
    ({ items, token } = rowsOf(await call("browse", { continuation: token })));
  }
  likedSet = set;
  likedAt = Date.now();
  return set;
}

export async function isLiked({ ids }) {
  const set = cookie() ? await likedIds() : new Set();
  return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
}

export async function like({ id, on }) {
  needAccount();
  await call(on ? "like/like" : "like/removelike", { target: { videoId: id } });
  if (likedSet) {
    if (on) likedSet.add(id);
    else likedSet.delete(id);
  }
}

export async function recent() {
  if (!cookie()) return [];
  const sections = await sectionsOf(await browseId("FEmusic_history"));
  return sections.flatMap((s) => s.tracks).slice(0, 50);
}

// Radio: songs like the one last played.

const defaultRadio = { id: "radio", name: t("Radio"), description: t("Songs like the one you played last."), public: true };

export function stations() { return [defaultRadio]; }

export async function radio({ kind, id }) {
  if (!id) throw fail("unavailable", t("No radio is available"));
  if (kind === "track") return stationFor({ videoId: id, playlistId: `RDAMVM${id}` }, t("Song Radio"));
  if (kind !== "artist") throw fail("unavailable", t("No radio is available"));
  const answer = await browseId(id);
  const header = findOne(answer, "musicImmersiveHeaderRenderer") || findOne(answer, "musicVisualHeaderRenderer") || {};
  const endpoint = watchOf(header.startRadioButton?.buttonRenderer?.navigationEndpoint);
  if (!endpoint) throw fail("unavailable", t("No radio is available"));
  return stationFor(endpoint, `${textOf(header.title)} · ${t("Artist Radio")}`, imageOf(header.thumbnail || header.foregroundThumbnail));
}

// What's played also goes in your history on YouTube Music, which its
// recommendations are made from, as its own player would put it there.
export async function played({ id }) {
  host.storage.set("lastPlayed", id);
  if (!cookie()) return;
  try {
    await report(id);
  } catch (e) {
    console.warn(`reporting ${id} as played: ${e.message}`);
  }
}

async function report(id) {
  const r = await call("player", { videoId: id, playbackContext: { contentPlaybackContext: {} } });
  const base = r.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
  if (!base) throw new Error(t("YouTube gave no address to report it to"));
  const url = new URL(base);
  // The session goes with it, so it goes to YouTube alone.
  if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(url.hostname)) {
    throw new Error(`not sending your session to ${url.hostname}`);
  }
  url.searchParams.set("ver", "2");
  url.searchParams.set("c", "WEB_REMIX");
  url.searchParams.set("cpn", playbackNonce());
  const res = await fetch(url.href, {
    headers: { "user-agent": webUA, referer: `${site}/`, ...authHeaders(url.origin) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
}

// The 16 characters a player sends to tell one playback from another.
function playbackNonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * 64)];
  return out;
}

function panelTrack(v) {
  const credits = creditsOf(v.longBylineText?.runs);
  credits.duration = msOf(textOf(v.lengthText));
  return trackFrom(v.videoId, textOf(v.title), credits, imageOf(v.thumbnail));
}

// One queue owns one endpoint and continuation. Commit state only after all
// requests succeed so a transient failure never consumes a page.
const stationStates = new Map();
const stationLocks = new Map();
let legacyStation = "";
let sessionGeneration = 0;

function saveRadio(id, state) {
  stationStates.set(id, state);
  const saved = host.storage.get("radioSessions") || {};
  delete saved[id];
  saved[id] = state;
  const entries = Object.entries(saved).slice(-12);
  host.storage.set("radioSessions", Object.fromEntries(entries));
}

async function nextRadioPage(endpoint, continuation) {
  const body = { ...endpoint, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: "AUTOMIX_SETTING_NORMAL" };
  if (continuation) body.continuation = continuation;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await call("next", body);
      const panel = answer.continuationContents?.playlistPanelContinuation || findOne(answer, "playlistPanelRenderer");
      if (!panel) throw fail("emptyRadio", t("YouTube gave no radio queue"));
      return {
        tracks: (panel.contents || []).flatMap((item) => item.playlistPanelVideoRenderer?.videoId ? [panelTrack(item.playlistPanelVideoRenderer)] : []),
        continuation: nextToken(panel) || null,
        automix: watchOf(findOne(panel, "automixPlaylistVideoRenderer")?.navigationEndpoint),
      };
    } catch (e) {
      if (e.code === "signIn" || e.code === "unavailable") throw e;
      last = e;
    }
  }
  throw last;
}

export async function stationNext({ id = "radio" } = {}) {
  if (id === "radio") {
    if (!legacyStation) {
      let seed = host.storage.get("lastPlayed");
      if (!seed) seed = (await home()).sections.flatMap((s) => s.tracks || [])[0]?.id;
      if (!seed) return [];
      legacyStation = (await radio({ kind: "track", id: seed })).id;
    }
    id = legacyStation;
  }
  const generation = sessionGeneration;
  const before = stationLocks.get(id) || Promise.resolve();
  const task = before.catch(() => {}).then(async () => {
    if (!id.startsWith("yt-radio:")) throw fail("unavailable", t("No radio is available"));
    const seed = JSON.parse(decodeURIComponent(id.slice(9))).endpoint;
    const old = stationStates.get(id) || host.storage.get("radioSessions")?.[id];
    const state = old ? { ...old, seen: [...old.seen] } : { endpoint: seed, continuation: null, seen: seed.videoId ? [seed.videoId] : [], started: false, finished: false };
    if (state.finished) return [];
    const seen = new Set(state.seen);
    const tracks = [];
    for (let page = 0; page < 4; page++) {
      let result;
      try { result = await nextRadioPage(state.endpoint, state.continuation); }
      catch (error) {
        if (state.continuation && (error.status === 400 || error.status === 404 || error.code === "emptyRadio")) {
          result = await nextRadioPage(state.endpoint, null);
        } else if (!state.started && state.endpoint.playlistId?.startsWith("RDAMVM") && error.code === "emptyRadio") {
          state.endpoint = { videoId: state.endpoint.videoId };
          result = await nextRadioPage(state.endpoint, null);
        } else throw error;
      }
      if (!state.started && result.tracks.length <= 1 && state.endpoint.playlistId?.startsWith("RDAMVM")) {
        state.endpoint = { videoId: state.endpoint.videoId };
        result = await nextRadioPage(state.endpoint, null);
      }
      state.started = true;
      for (const track of result.tracks) if (!seen.has(track.id) && !track.unavailable) {
        seen.add(track.id);
        tracks.push(track);
      }
      state.continuation = result.continuation;
      if (result.automix) {
        state.endpoint = result.automix;
        state.continuation = null;
      }
      state.finished = !state.continuation && !result.automix;
      if (tracks.length || state.finished) break;
    }
    state.seen = [...seen].slice(-2000);
    if (generation !== sessionGeneration) return [];
    saveRadio(id, state);
    return tracks;
  });
  stationLocks.set(id, task);
  try { return await task; } finally { if (stationLocks.get(id) === task) stationLocks.delete(id); }
}

// Lyrics sources fail independently. Only real timestamps enable synchronized
// display; plain lyrics and explicitly instrumental records keep their meaning.
const lyricCache = new Map();
const lyricCooldown = new Map();
const lyricUA = "MyGo Music/0.1.28 (https://github.com/maxbeau/mygo-music)";
const hasTimedLyrics = (l) => Boolean(l?.lines?.length || /\[\d+:\d+(?:[.:]\d+)?\]/.test(l?.lrc || ""));
const hasLyrics = (l) => hasTimedLyrics(l) || Boolean(l?.text?.trim() || l?.instrumental);

async function lyricDeadline(run, ms) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([run(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Lyrics request timed out")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function lyricJSON(url) {
  const host = new URL(url).hostname;
  if ((lyricCooldown.get(host) || 0) > Date.now()) throw new Error("Lyrics provider temporarily unavailable");
  return lyricDeadline(async(signal) => {
    const res = await fetch(url, { signal, headers: { "user-agent": lyricUA } });
    if (res.status === 404) return null;
    // Availability varies by recording; never send the YouTube session here.
    if (res.status === 401 && host === "api.betterlyrics.org") {
      return null;
    }
    if (res.status === 429 || res.status === 503) {
      const value = res.headers?.get("retry-after");
      const seconds = Number(value);
      const delay = value && !Number.isFinite(seconds) ? Date.parse(value) - Date.now() : (seconds || 60) * 1000;
      lyricCooldown.set(host, Date.now() + Math.max(1000, delay));
    }
    if (!res.ok) throw new Error(`Lyrics provider: ${res.status}`);
    return res.json();
  }, 3000);
}

export async function lyrics({ id, track }) {
  if (lyricCache.has(id)) return lyricCache.get(id);
  const next = lyricDeadline(signal => call("next", { videoId: id, isAudioOnly: true }, remix, signal), 4000);
  // Attach a rejection handler immediately even when supplied metadata needs no next response.
  const metadata = track?.name ? Promise.resolve(track) : next.then(r => {
    const playing = findAll(r, "playlistPanelVideoRenderer").find(v => v.videoId === id);
    return playing ? panelTrack(playing) : null;
  }).catch(() => null);
  const own = next.then(r => lyricDeadline(signal => youtubeLyrics(r, signal), 4000));
  const errors = [];
  const other = metadata.then(async (song) => {
    if (!song?.name || !song.artists?.length) return null;
    let fallback = null;
    for (const provider of [betterLyrics, lrcLibLyrics, kugouLyrics]) {
      try {
        const result = await provider(song);
        if (hasTimedLyrics(result)) return result;
        if (hasLyrics(result) && !fallback) fallback = result;
      } catch (error) { errors.push(error); }
    }
    return fallback;
  });
  const result = await new Promise((resolve, reject) => {
    const values = [];
    let left = 2;
    [own, other].forEach((task, i) => {
      task.then(value => {
        values[i] = value;
        if (hasTimedLyrics(value)) resolve(value);
      }, error => { errors.push(error); }).finally(() => {
        if (--left === 0) {
          const found = values.find(v => v?.text?.trim()) || values.find(v => v?.instrumental);
          if (found) resolve(found);
          else if (errors.length) reject(new Error("Couldn't load lyrics from the available providers"));
          else resolve({ lines: [] });
        }
      });
    });
  });
  if (hasLyrics(result)) {
    lyricCache.set(id, result);
    if (lyricCache.size > 64) lyricCache.delete(lyricCache.keys().next().value);
  }
  return result;
}

function lyricTitle(title) {
  // Remove presentation labels, keeping Live/Remix/Cover and year qualifiers.
  return title.replace(/\bOfficial\s+(?:Music\s+)?(?:Video|Audio|Lyrics?)\b/gi, "")
    .replace(/[([【]\s*(?:HD|HQ|4K|高清|高音质)\s*[)\]】]/gi, "").replace(/[([【]\s*[)\]】]/g, "").trim();
}
const lyricKey = s => lyricTitle(s || "").normalize("NFKC").toLowerCase().replace(/现场|現場/g, "live").replace(/[^\p{L}\p{N}]/gu, "");

function matchesLyricTrack(song, title, artist, duration, tolerance = 5) {
  if (lyricKey(song.name) !== lyricKey(title)) return false;
  const artists = (artist || "").split(/[,，、;&]/).map(lyricKey).filter(Boolean);
  if (!song.artists.some(a => artists.includes(lyricKey(a.name)))) return false;
  return !song.duration || !(duration > 0) || Math.abs(song.duration / 1000 - duration) <= tolerance;
}

async function lrcLibLyrics(song) {
  const query = new URLSearchParams({ track_name: lyricTitle(song.name), artist_name: song.artists[0].name });
  if (song.album?.name) query.set("album_name", song.album.name);
  if (song.duration > 0 && song.duration <= 3600000) query.set("duration", String(Math.round(song.duration / 1000)));
  let record = await lyricJSON(`https://lrclib.net/api/get?${query}`);
  const matches = r => r && matchesLyricTrack(song, r.trackName, r.artistName, r.duration);
  if (!matches(record) || !(record.syncedLyrics || record.plainLyrics || record.instrumental)) {
    const search = new URLSearchParams({ track_name: lyricTitle(song.name), artist_name: song.artists[0].name });
    const records = await lyricJSON(`https://lrclib.net/api/search?${search}`);
    record = (Array.isArray(records) ? records : []).filter(r => matches(r) && (r.syncedLyrics || r.plainLyrics || r.instrumental))
      .sort((a,b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) || Math.abs(a.duration - song.duration/1000) - Math.abs(b.duration - song.duration/1000))[0];
  }
  if (!record) return null;
  if (record.syncedLyrics) return { lrc: record.syncedLyrics };
  if (record.plainLyrics) return { text: record.plainLyrics };
  return record.instrumental ? { instrumental: true } : null;
}

async function kugouLyrics(song) {
  const query = new URLSearchParams({ ver: "1", man: "yes", client: "pc", keyword: `${lyricTitle(song.name)} - ${song.artists[0].name}` });
  if (song.duration) query.set("duration", String(song.duration));
  const result = await lyricJSON(`https://lyrics.kugou.com/search?${query}`);
  const candidate = result?.candidates?.filter(c => matchesLyricTrack(song, c.song, c.singer, c.duration/1000, 8))
    .sort((a,b) => Math.abs(a.duration - song.duration) - Math.abs(b.duration - song.duration))[0];
  if (!candidate) return null;
  const params = new URLSearchParams({ fmt: "lrc", charset: "utf8", client: "pc", ver: "1", id: candidate.id, accesskey: candidate.accesskey });
  const data = await lyricJSON(`https://lyrics.kugou.com/download?${params}`);
  if (!data?.content) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  let bits = 0, value = 0;
  for (const char of data.content.replace(/\s/g, "")) {
    if (char === "=") break;
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Invalid encoded lyrics");
    value = (value << 6) | n;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  const lrc = new TextDecoder().decode(new Uint8Array(bytes));
  return hasTimedLyrics({ lrc }) ? { lrc } : null;
}

// Better Lyrics answers only for songs it has kept, and says so with a status:
// none, not kept, or too busy are all no lyrics.
async function betterLyrics(track) {
  const query = new URLSearchParams({ s: track.name, a: track.artists.map((a) => a.name).join(", ") });
  if (track.album?.name) query.set("al", track.album.name);
  if (track.duration) query.set("d", String(Math.round(track.duration / 1000)));
  const data = await lyricJSON(`https://api.betterlyrics.org/getLyrics?${query}`);
  const lines = linesOfTTML(data?.ttml || "");
  return lines.length ? { lines } : null;
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXML = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) =>
    e[0] !== "#" ? (entities[e] ?? all) : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

// A time as TTML writes it, such as 1:02.500 or 62.5, in milliseconds.
function clockOf(value) {
  if (!value) return null;
  const offset = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s)$/);
  if (offset) return Math.round(Number(offset[1]) * (offset[2] === "s" ? 1000 : 1));
  const parts = value.trim().replace(/s$/, "").split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || !(Number(p) >= 0))) return null;
  return Math.round(parts.reduce((sum, p) => sum * 60 + Number(p), 0) * 1000);
}

const attrOf = (attrs, name) => attrs.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];

// The lines of a TTML document: each <p> is a line, and each <span> in it with a
// time is a word, or part of one. The text between them is the spacing, which
// goes with the word before it. A span with no time only groups others, such
// as background vocals, and its words are the line's own.
function linesOfTTML(ttml) {
  const lines = [];
  for (const [, pAttrs, body] of ttml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const words = [];
    let text = "";
    let lead = ""; // what comes before the first word
    let word = null; // the word being read, and how many spans deep in it
    let depth = 0;
    for (const [, close, name, attrs, chars] of body.matchAll(/<(\/?)([\w:.-]+)([^>]*?)\/?>|([^<]+)/g)) {
      if (chars !== undefined) {
        const s = unescapeXML(chars);
        text += s;
        if (word) word.text += s;
        else if (words.length) words[words.length - 1].text += s;
        else lead += s;
        continue;
      }
      if (name !== "span") continue;
      if (close) {
        if (word && --depth === 0) {
          words.push(word);
          word = null;
        }
      } else if (word) {
        depth++;
      } else {
        const start = clockOf(attrOf(attrs, "begin"));
        if (start === null) continue;
        word = { start, end: clockOf(attrOf(attrs, "end")) ?? start, text: lead.trimStart() };
        lead = "";
        depth = 1;
      }
    }
    const start = clockOf(attrOf(pAttrs, "begin")) ?? words[0]?.start;
    const end = clockOf(attrOf(pAttrs, "end")) ?? words[words.length - 1]?.end ?? 0;
    text = text.replace(/\s+/g, " ").trim();
    // A line with no time can't be followed.
    if (text && start != null) lines.push({ start, end, text, words: words.length ? words : undefined });
  }
  return lines;
}

async function youtubeLyrics(next, signal) {
  const endpoint = findAll(next, "browseEndpoint").find(e => /^MPLY/.test(e.browseId));
  if (!endpoint) return { lines: [] };
  const r = await call("browse", { browseId: endpoint.browseId, ...(endpoint.params ? { params: endpoint.params } : {}) }, remix, signal);
  const timed = findOne(r, "timedLyricsData") || [];
  const lines = timed
      .filter((l) => l.lyricLine && l.cueRange?.startTimeMilliseconds != null && Number.isFinite(Number(l.cueRange.startTimeMilliseconds)))
      .map((l) => ({
        start: Number(l.cueRange?.startTimeMilliseconds) || 0,
        end: Number(l.cueRange?.endTimeMilliseconds) || 0,
        text: l.lyricLine,
      }));
  if (lines.length) return { lines };
  const text = findAll(r, "musicDescriptionShelfRenderer").map(s => textOf(s.description)).filter(Boolean).join("\n\n") || timed.map(l => l.lyricLine).filter(Boolean).join("\n");
  return text.trim() ? { text: text.trim() } : { lines: [] };
}

// Playing.

const installed = {};

// GUI apps don't get a shell's PATH, so where Homebrew installs programs is
// tried too. Those are the places the process permission in plugin.json names,
// so a new one goes there as well. Starting one is the only way a plugin can
// tell it's there.
async function program(name, versionFlag) {
  if (installed[name]) return installed[name];
  const places = [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  for (const path of places) {
    try {
      const proc = host.spawn(path, [versionFlag]);
      proc.closeStdin();
      while ((await proc.readLine()) !== null) {}
      if ((await proc.wait()) === 0) {
        installed[name] = path;
        return path;
      }
    } catch (e) {
      if (/allowed/.test(e.message)) {
        throw fail("setup", t("Allow YouTube Music to start programs in its settings"));
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where a track's audio is, and how loud it is. Its address lasts for hours.
const located = new Map();
const locatedFor = 60 * 60 * 1000;

async function locate(id) {
  const known = located.get(id);
  if (known && Date.now() - known.at < locatedFor) return known;
  let found;
  try {
    found = await direct(id);
  } catch (e) {
    // What YouTube won't play, yt-dlp can't either.
    if (e.code === "unavailable") throw e;
    console.warn(`finding ${id}'s audio: ${e.message}`);
    visitor = "";
    found = await throughYtdlp(id, e);
  }
  found.at = Date.now();
  located.set(id, found);
  return found;
}

// A visit gets an ID before it's given any audio, or it's asked if it's a bot.
let visitor = "";

async function visitorData() {
  if (visitor) return visitor;
  const r = await call("visitor_id", {}, { ...remix, anonymous: true });
  visitor = r.responseContext?.visitorData || "";
  if (!visitor) throw new Error(t("YouTube gave this visit no ID"));
  return visitor;
}

// The audio of the highest bit rate, as yt-dlp picks it: in the track's own
// language, and as it was mixed, rather than the copy with its range
// compressed, which YouTube lists beside it.
async function direct(id) {
  const r = await call("player", { videoId: id, contentCheckOk: true, racyCheckOk: true }, visionOS(await visitorData()));
  const status = r.playabilityStatus || {};
  if (status.status !== "OK") {
    const why = status.reason || `YouTube says ${status.status || "nothing"} of this`;
    throw status.status === "UNPLAYABLE" || status.status === "ERROR" ? fail("unavailable", why) : new Error(why);
  }
  let best = null;
  for (const f of r.streamingData?.adaptiveFormats || []) {
    if (!f.mimeType?.startsWith("audio/") || !f.url || f.isDrc) continue;
    if (f.audioTrack && !f.audioTrack.audioIsDefault) continue;
    if (!best || f.bitrate > best.bitrate) best = f;
  }
  if (!best) throw new Error(t("YouTube listed no audio to play as it is"));
  return { url: best.url, http_headers: { "User-Agent": webUA }, gain: gainOf(r.playerConfig?.audioConfig), direct: true };
}

// The app's gain is ReplayGain's, which brings a track to -18 LUFS, and YouTube
// says how loud a track is.
function gainOf(audio) {
  const lkfs = audio?.trackAbsoluteLoudnessLkfs ?? audio?.perceptualLoudnessDb;
  if (typeof lkfs !== "number" || !lkfs) return undefined;
  return Math.round((-18 - lkfs) * 100) / 100;
}

// The cookie goes to yt-dlp on its standard input, as anyone on this machine can
// read the arguments of a program.
function ytdlpConfig() {
  const c = cookie();
  return c ? `--add-headers "Cookie:${c.replace(/[\\"]/g, "\\$&")}"\n` : "";
}

const ytdlpTimeout = 25000;

// yt-dlp finds the audio as YouTube's website does, which takes it a few
// seconds, and a JavaScript runtime to work out YouTube's challenges. Without
// it, what went wrong without it stands.
async function throughYtdlp(id, why) {
  const ytdlp = await program("yt-dlp", "--version");
  if (!ytdlp) throw why;
  const args = [
    "--config-locations", "-",
    "--no-warnings", "--no-playlist", "--no-progress",
    ...whatYtdlpAsks(),
    "--print", "%(.{url,http_headers})j",
  ];
  for (const runtime of ["deno", "node", "bun"]) {
    const path = await program(runtime, "--version");
    if (path) {
      args.push("--js-runtimes", `${runtime}:${path}`);
      break;
    }
  }
  args.push(`https://www.youtube.com/watch?v=${id}`);

  const proc = host.spawn(ytdlp, args);
  proc.write(ytdlpConfig());
  proc.closeStdin();
  const timer = setTimeout(() => proc.kill(), ytdlpTimeout);
  const lines = [];
  for (let line; (line = await proc.readLine()) !== null; ) lines.push(line);
  const code = await proc.wait();
  clearTimeout(timer);
  if (code !== 0 || !lines.length) throw ytdlpFailure(proc.errorOutput());
  return { ...JSON.parse(lines[lines.length - 1]), direct: false };
}

// Which of YouTube's apps yt-dlp asks as, and for what. Signed out, its own
// choice works, and the audio alone, as one file. With a session it asks as the
// embedded player, whose addresses YouTube now turns down with no token from
// its JavaScript, which yt-dlp can't make. Safari's are good, but only as HLS,
// with video: at 360p, its audio is the AAC YouTube has on its own.
function whatYtdlpAsks() {
  if (!cookie()) {
    return ["--extractor-args", "youtube:skip=hls,dash", "--format", "bestaudio[protocol^=http]/bestaudio"];
  }
  return [
    "--extractor-args", "youtube:player_client=web_safari",
    "--format", "bestaudio[protocol^=m3u8]/93/94/92/95/91",
  ];
}

function ytdlpFailure(output) {
  const said = output.split("\n").reverse().find((l) => l.startsWith("ERROR:")) || output.trim() || "yt-dlp stopped";
  const why = said.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?(\S+:\s*)?/, "");
  if (/not a bot|sign in|cookies/i.test(why)) {
    return fail("signIn", cookie() ? t("YouTube turned down your session: sign in again") : t("YouTube asks you to sign in to play this"));
  }
  if (/unavailable|private|removed|not available|premium/i.test(why)) return fail("unavailable", why);
  return new Error(why);
}

// YouTube's own player asks for its audio a piece at a time, and serves one
// request for all of it slowly. An older ffmpeg can't ask that way.
let ranged = null;

async function asksInPieces(ffmpeg) {
  if (ranged !== null) return ranged;
  const proc = host.spawn(ffmpeg, ["-hide_banner", "-h", "protocol=http"]);
  proc.closeStdin();
  let found = false;
  for (let line; (line = await proc.readLine()) !== null; ) found ||= line.includes("-request_size");
  await proc.wait();
  return (ranged = found);
}

// ffmpeg serves the MP3 itself, to the one request that comes for it, and so
// lets the track start before all of it is there. No more than a few wait at a
// time, for what was skipped before it was ever asked for.
const serving = [];
const servingAtMost = 3;
const servedWithin = 10 * 60 * 1000;

function stopWaiting() {
  while (serving.length >= servingAtMost) serving.shift().kill();
}

async function serve(source, bitRate) {
  const ffmpeg = await program("ffmpeg", "-version");
  if (!ffmpeg) {
    throw fail("setup", t("YouTube Music plays through ffmpeg: install it with Homebrew, or so that it's on the PATH"));
  }
  const pieces = await asksInPieces(ffmpeg);
  stopWaiting();
  const headers = source.http_headers || {};
  const port = 20000 + Math.floor(Math.random() * 40000);
  const proc = host.spawn(ffmpeg, [
    "-nostdin", "-hide_banner", "-nostats",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-rw_timeout", "15000000",
    ...(pieces ? ["-request_size", String(10 << 20)] : []),
    ...(headers["User-Agent"] ? ["-user_agent", headers["User-Agent"]] : []),
    "-i", source.url,
    "-vn", "-c:a", "libmp3lame", "-b:a", `${bitRate}k`, "-id3v2_version", "0", "-write_xing", "0",
    "-f", "mp3", "-listen", "1", `http://127.0.0.1:${port}/`,
  ]);
  proc.closeStdin();
  let stopped = false;
  serving.push(proc);
  const timer = setTimeout(() => proc.kill(), servedWithin);
  proc.wait().then(() => {
    stopped = true;
    clearTimeout(timer);
    const at = serving.indexOf(proc);
    if (at >= 0) serving.splice(at, 1);
  });
  // It says what it's reading right before it opens the port. Trying the port
  // isn't a way to find out: it would take the one request ffmpeg answers.
  const until = Date.now() + 15000;
  while (!proc.errorOutput().includes("Input #0")) {
    if (stopped) throw new Error(`ffmpeg stopped: ${proc.errorOutput().trim().split("\n").pop()}`);
    if (Date.now() > until) {
      proc.kill();
      throw new Error(t("the audio didn't start in time"));
    }
    await sleep(30);
  }
  await sleep(100);
  return `http://127.0.0.1:${port}/`;
}

export async function stream({ id, quality }) {
  const kbps = quality === "standard" ? 128 : 192;
  let source = await locate(id);
  let url;
  try {
    url = await serve(source, kbps);
  } catch (e) {
    // An address may stop working before it said it would, and YouTube now and
    // then turns down one it just gave out: yt-dlp may find one that works.
    located.delete(id);
    if (!source.direct || e.code === "setup") throw e;
    console.warn(`playing ${id} as YouTube gave it: ${e.message}`);
    source = { ...(await throughYtdlp(id, e)), gain: source.gain, at: Date.now() };
    url = await serve(source, kbps);
    located.set(id, source);
  }
  return {
    url,
    type: "mp3",
    quality: kbps === 128 ? "standard" : "high",
    bitRate: kbps * 1000,
    gain: source.gain,
  };
}

// Cloud writes use playlist occurrence IDs. A video may occur more than once.
const playlistRows = new Map();
const playlistLocks = new Map();

function mutationOK(answer) {
  if (answer.error || answer.status && answer.status !== "STATUS_SUCCEEDED" && answer.status !== "SUCCESS") {
    throw new Error(answer.error?.message || t("YouTube refused the change"));
  }
  return answer;
}

async function mutate(endpoint, body) {
  needAccount();
  return mutationOK(await call(endpoint, body));
}

export async function savePlaylist({ id, on }) {
  await mutate(on ? "like/like" : "like/removelike", { target: { playlistId: plainPlaylistId(id) } });
}

export async function followArtist({ id, on }) {
  needAccount();
  const answer = await browseId(id);
  const channel = findOne(answer, "subscribeButtonRenderer")?.channelId || (/^UC/.test(id) ? id : "");
  if (!channel) throw fail("unavailable", t("YouTube gave no artist channel"));
  await mutate(on ? "subscription/subscribe" : "subscription/unsubscribe", { channelIds: [channel], params: "EgIIAhgA" });
}

export async function saveAlbum({ id, on }) {
  needAccount();
  const answer = await browseId(id);
  const target = findAll(answer, "likeEndpoint").map((e) => e.target?.playlistId).find(Boolean) ||
    findAll(answer, "watchEndpoint").map((e) => e.playlistId).find(Boolean);
  if (!target) throw fail("unavailable", t("YouTube gave no album playlist"));
  await savePlaylist({ id: target, on });
}

export async function savedAlbums({ offset = 0 }) {
  needAccount();
  const token = pageToken("savedAlbums", offset);
  if (offset > 0 && !token) return { albums: [], more: false };
  const answer = token ? await call("browse", { continuation: token }) : await browseId("FEmusic_liked_albums");
  const sections = await sectionsOf(answer);
  const albums = sections.flatMap((s) => s.albums || []).map((a) => ({ ...a, saved: true }));
  return { albums, more: albums.length > 0 && keepToken("savedAlbums", offset + albums.length, nextToken(answer)) };
}

export async function createPlaylist({ name }) {
  const answer = await mutate("playlist/create", { title: name, privacyStatus: "PRIVATE" });
  if (!answer.playlistId) throw new Error(t("YouTube gave no playlist ID"));
  return { id: answer.playlistId, name, mine: true, tracks: [] };
}

export async function renamePlaylist({ id, name }) {
  await mutate("browse/edit_playlist", { playlistId: plainPlaylistId(id), actions: [{ action: "ACTION_SET_PLAYLIST_NAME", playlistName: name }] });
}

export async function deletePlaylist({ id }) {
  await mutate("playlist/delete", { playlistId: plainPlaylistId(id) });
  playlistRows.delete(plainPlaylistId(id));
}

function playlistWrite(id, fn) {
  const old = playlistLocks.get(id) || Promise.resolve();
  const generation = sessionGeneration;
  const task = old.catch(() => {}).then(() => {
    if (generation !== sessionGeneration) throw fail("signIn");
    return fn();
  });
  playlistLocks.set(id, task);
  return task.finally(() => { if (playlistLocks.get(id) === task) playlistLocks.delete(id); });
}

export async function addToPlaylist({ id, trackIds }) {
  needAccount();
  return playlistWrite(id, async () => {
    if (!trackIds.length) return;
    await mutate("browse/edit_playlist", { playlistId: plainPlaylistId(id), actions: trackIds.map((videoId) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId })) });
    playlistRows.delete(plainPlaylistId(id));
  });
}

export async function removeFromPlaylist({ id, trackIds }) {
  needAccount();
  return playlistWrite(id, async () => {
    const rows = await playlistEntries(id);
    const wanted = new Set(trackIds);
    const selected = rows.filter((r) => wanted.has(r.id));
    if (!selected.length) return;
    if (selected.some((r) => !r.setVideoId)) throw new Error(t("Reload the playlist before editing it"));
    await mutate("browse/edit_playlist", { playlistId: plainPlaylistId(id), actions: selected.map((r) => ({ action: "ACTION_REMOVE_VIDEO", removedVideoId: r.id, setVideoId: r.setVideoId })) });
    playlistRows.set(plainPlaylistId(id), rows.filter((r) => !wanted.has(r.id)));
  });
}

export async function movePlaylistTrack({ id, from, to }) {
  needAccount();
  return playlistWrite(id, async () => {
    const expected = playlistRows.get(plainPlaylistId(id));
    const rows = await playlistEntries(id);
    if (expected && (expected.length !== rows.length || expected.some((r, i) => r.setVideoId !== rows[i].setVideoId))) {
      throw new Error(t("Reload the playlist before editing it"));
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= rows.length || to >= rows.length) throw new Error(t("Reload the playlist before editing it"));
    if (from === to) return;
    const moved = [...rows];
    const [entry] = moved.splice(from, 1);
    moved.splice(to, 0, entry);
    const successor = moved[to + 1];
    if (!entry.setVideoId || successor && !successor.setVideoId) throw new Error(t("Reload the playlist before editing it"));
    await mutate("browse/edit_playlist", { playlistId: plainPlaylistId(id), actions: [{ action: "ACTION_MOVE_VIDEO_BEFORE", setVideoId: entry.setVideoId, movedSetVideoIdSuccessor: successor?.setVideoId || null }] });
    playlistRows.set(plainPlaylistId(id), moved);
  });
}

async function playlistEntries(id) {
  const rows = await playlistTracks(await browseId(`VL${plainPlaylistId(id)}`));
  return rows.map((r) => ({ id: r.id, setVideoId: r.playlistItemId }));
}

async function playlistTracks(answer) {
  const tracks = [];
  const seen = new Set();
  for (let page = 0; ; page++) {
    const { items, token } = rowsOf(answer);
    tracks.push(...ofKind(items, "track"));
    if (!token) break;
    if (seen.has(token) || page >= pagesAtMost) throw new Error(t("The playlist is too large to edit safely"));
    seen.add(token);
    answer = await call("browse", { continuation: token });
  }
  return tracks;
}
