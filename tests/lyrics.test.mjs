import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const song = { id:'seed', name:'Song', artists:[{name:'Singer'}], album:{name:'Album'}, duration:180000 };
const lrc = '[00:01.00]First line\n[00:03.00]Second line';
const record = extra => ({trackName:'Song', artistName:'Singer', duration:180, ...extra});
const next = { tabs:[{tabRenderer:{endpoint:{browseEndpoint:{browseId:'MPLYlyrics',params:'lyrics-tab'}}}}] };

async function plugin(answer, options={}) {
  const requests=[];
  const context=vm.createContext({host:{t:x=>x,language:()=> 'en',storage:{get:k=>k==='cookie'?options.cookie:undefined,set:()=>{},remove:()=>{}}},
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Uint8Array,
    setTimeout:options.setTimeout||setTimeout, clearTimeout, console,
    fetch:async(url,opts={})=>{
      const u=new URL(url);const body=opts.body?JSON.parse(opts.body):null;
      requests.push({url:u,opts,body});
      const result=await answer(u,body,opts,requests);
      const status=result?.status??200;
      return {ok:status>=200&&status<300,status,headers:{get:k=>result?.headers?.[k]},json:async()=>result?.data??result};
    }});
  const mod=new vm.SourceTextModule(code,{context});await mod.link(()=>{});await mod.evaluate();
  return {api:mod.namespace,requests};
}

// A timed fallback works even when YouTube's next endpoint fails, using host-supplied metadata.
test('lyrics use track metadata when YouTube fails',async()=>{
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')throw new Error('next down');
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return record({syncedLyrics:lrc});
    throw new Error('unexpected provider');
  },{cookie:'SAPISID=test-only'});
  const result=await p.api.lyrics({id:'seed',track:song});
  assert.equal(result.lrc,lrc);
  const request=p.requests.find(r=>r.url.hostname==='lrclib.net');
  assert.equal(request.url.searchParams.get('duration'),'180');
  assert.equal(request.opts.headers.cookie,undefined);
  assert.equal(request.opts.headers.authorization,undefined);
});

// Plain YouTube lyrics retain their text and browse parameters instead of disappearing.
test('YouTube plain lyrics survive failed timed providers',async()=>{
  const p=await plugin((u,b)=>{
    if(u.hostname==='music.youtube.com')return b.videoId?next:{musicDescriptionShelfRenderer:{description:{runs:[{text:'First line\n'},{text:'Second line'}]}}};
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return {status:404};
    return {candidates:[]};
  });
  const result=await p.api.lyrics({id:'seed',track:song});
  assert.equal(result.text,'First line\nSecond line');
  const browse=p.requests.find(r=>r.body?.browseId);
  assert.equal(browse.body.params,'lyrics-tab');
  assert.equal(browse.body.context.client.clientName,'WEB_REMIX');
});

// Live recordings must not receive a studio version merely because its title is similar.
test('lyrics reject wrong artist duration and recording version',async()=>{
  const p=await plugin((u,b)=>{
    if(u.hostname==='music.youtube.com')return {};
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return u.pathname==='/api/get'?{status:404}:[record({syncedLyrics:lrc}),record({trackName:'Song (Live)',artistName:'Other',syncedLyrics:lrc}),record({trackName:'Song (Live)',duration:240,syncedLyrics:lrc})];
    return {candidates:[]};
  });
  const result=await p.api.lyrics({id:'live',track:{...song,name:'Song (Live)'}});
  assert.equal(result.lines.length,0);
});

// Exact live-version matches retain synchronized lyrics after removing only presentation labels.
test('lyrics keep live qualifiers while removing official-video labels',async()=>{
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')return {};
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return record({trackName:'Song (Live)',syncedLyrics:lrc});
    return {candidates:[]};
  });
  assert.equal((await p.api.lyrics({id:'live',track:{...song,name:'Song (Live) [Official Video]'}})).lrc,lrc);
});

// KuGou base64 is decoded as UTF-8, and a mismatched first candidate is skipped.
test('KuGou fallback selects matching timed lyrics',async()=>{
  const text='[00:01.00]测试歌词';
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')return {};
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return {status:404};
    if(u.pathname==='/search')return {candidates:[{id:'wrong',song:'Song',singer:'Other',duration:180000},{id:'right',accesskey:'candidate-token',song:'Song',singer:'Singer',duration:180000}]};
    assert.equal(u.searchParams.get('id'),'right');
    return {content:Buffer.from(text).toString('base64')};
  });
  assert.equal((await p.api.lyrics({id:'seed',track:song})).lrc,text);
});

// A 429 stops queries to that provider until Retry-After, without blocking another provider.
test('lyrics honor provider rate limits',async()=>{
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')return next;
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return {status:429,headers:{'retry-after':'120'}};
    return {candidates:[]};
  });
  await assert.rejects(p.api.lyrics({id:'one',track:song}));
  await assert.rejects(p.api.lyrics({id:'two',track:song}));
  assert.equal(p.requests.filter(r=>r.url.hostname==='lrclib.net').length,1);
});

// Network failure is retryable and does not enter the successful-lyrics cache.
test('failed lyrics can be retried',async()=>{
  let online=false;
  const p=await plugin(u=>{
    if(u.hostname==='lrclib.net'&&online)return record({syncedLyrics:lrc});
    throw new Error('offline');
  });
  await assert.rejects(p.api.lyrics({id:'seed',track:song}));
  online=true;
  assert.equal((await p.api.lyrics({id:'seed',track:song})).lrc,lrc);
});

// A stalled provider is bounded; existing YouTube text still completes the request.
test('slow providers time out independently',async()=>{
  const p=await plugin((u,b,opts)=>{
    if(u.hostname==='music.youtube.com')return b.videoId?next:{musicDescriptionShelfRenderer:{description:{simpleText:'Plain lyrics'}}};
    if(u.hostname==='api.betterlyrics.org')return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
    if(u.hostname==='lrclib.net')return {status:404};
    return {candidates:[]};
  },{setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,20))});
  assert.equal((await p.api.lyrics({id:'seed',track:song})).text,'Plain lyrics');
});

// Instrumental is returned only when a matching record explicitly marks it.
test('lyrics retain an explicit instrumental result',async()=>{
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')return {};
    if(u.hostname==='api.betterlyrics.org')return {status:401};
    if(u.hostname==='lrclib.net')return record({instrumental:true});
    return {candidates:[]};
  });
  assert.equal((await p.api.lyrics({id:'seed',track:song})).instrumental,true);
});

// TTML accepts standard single-quoted attributes and millisecond offsets.
test('TTML preserves real word timings with offset units',async()=>{
  const p=await plugin(u=>{
    if(u.hostname==='music.youtube.com')return {};
    return {ttml:"<tt><body><p begin='1000ms' end='3s'><span begin='1s' end='2s'>One </span><span begin='2s' end='3s'>two</span></p></body></tt>"};
  });
  const result=await p.api.lyrics({id:'seed',track:song});
  assert.equal(result.lines[0].start,1000);
  assert.equal(result.lines[0].end,3000);
  assert.equal(result.lines[0].words[1].start,2000);
});

// Text-only lines from YouTube never become fabricated zero-time synchronized lyrics.
test('YouTube lines without cue ranges remain plain text',async()=>{
  const p=await plugin((u,b)=>b.videoId?next:{timedLyricsData:[{lyricLine:'First'},{lyricLine:'Second'}]});
  const result=await p.api.lyrics({id:'seed'});
  assert.equal(result.text,'First\nSecond');
  assert.equal(result.lines,undefined);
});

// Explicit searches expose alternate recordings without weakening automatic matching.
test('manual search filters providers and keeps preview text',async()=>{
 const p=await plugin(u=>{
  assert.equal(u.hostname,'lrclib.net');
  assert.equal(u.searchParams.get('track_name'),'Corrected');
  return [record({id:1,trackName:'Corrected (Live)',syncedLyrics:lrc})];
 });
 const rows=await p.api.searchLyrics({track:song,title:'Corrected',artist:'Singer',provider:'LRCLIB'});
 assert.equal(rows.length,1);assert.equal(rows[0].provider,'LRCLIB');assert.equal(rows[0].data.lrc,lrc);
 assert.equal(rows[0].title,'Corrected (Live)');assert.equal(p.requests.length,1);
});

// One provider failing does not discard a searchable alternative; KuGou downloads only after selection.
test('search keeps partial results and downloads selected KuGou lyrics',async()=>{
 let downloaded=0;
 const p=await plugin(u=>{
  if(u.hostname!=='lyrics.kugou.com')throw new Error('unavailable');
  if(u.pathname==='/search')return {candidates:[{id:'pick',accesskey:'test-only',song:'Song',singer:'Singer',duration:180000}]};
  downloaded++;assert.equal(u.searchParams.get('id'),'pick');assert.equal(u.searchParams.get('accesskey'),'test-only');
  return {content:Buffer.from(lrc).toString('base64')};
 });
 const rows=await p.api.searchLyrics({track:song,provider:'All'});
 assert.equal(rows.length,1);assert.equal(downloaded,0);
 const data=await p.api.lyricCandidate({id:rows[0].id});
 assert.equal(data.lrc,lrc);assert.equal(data.provider,'KuGou');assert.equal(downloaded,1);
});

// Refresh bypasses successful in-memory lyrics, while ordinary repeats use the cache.
test('explicit refresh bypasses lyric cache',async()=>{
 let text=lrc;
 const p=await plugin(u=>{
  if(u.hostname==='lrclib.net')return record({syncedLyrics:text});
  if(u.hostname==='music.youtube.com')return {};
  return {status:404};
 });
 assert.equal((await p.api.lyrics({id:'seed',track:song})).lrc,lrc);
 text='[00:01.00]Changed';
 assert.equal((await p.api.lyrics({id:'seed',track:song})).lrc,lrc);
 assert.equal((await p.api.lyrics({id:'seed',track:song,refresh:true})).lrc,text);
});
