'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
function normalizeUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new Error('YouTubeの動画URLを入力してください。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('YouTubeの動画URLを入力してください。');
  const host = url.hostname.toLowerCase();
  let id;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/)?.[1];
  }
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('YouTubeの動画URLを入力してください（再生リストだけのURLは使えません）。');
  return {id, url: `https://www.youtube.com/watch?v=${id}`};
}
function validateSettings(input) {
  const settings = {
    projectId: String(input.projectId || '').trim(), expectedAccount: String(input.expectedAccount || '').trim().toLowerCase(),
    outputDirectory: String(input.outputDirectory || '').trim(), adcFile: String(input.adcFile || '').trim(),
    model: input.model || MODELS[0], subscription: String(input.subscription || '').trim(), budgetId: String(input.budgetId || '').trim(),
  };
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(settings.projectId)) throw new Error('Google CloudのプロジェクトIDを入力してください。');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.expectedAccount)) throw new Error('使用するGoogleアカウントのメールアドレスを入力してください。');
  if (!MODELS.includes(settings.model)) throw new Error('指定されたGeminiモデルを選択してください。');
  if (!path.isAbsolute(settings.outputDirectory)) throw new Error('保存先フォルダを選択してください。');
  if (settings.adcFile && !path.isAbsolute(settings.adcFile)) throw new Error('認証ファイルはファイル選択で指定してください。');
  if (Boolean(settings.subscription) !== Boolean(settings.budgetId)) throw new Error('料金通知にはサブスクリプションと予算IDの両方が必要です。');
  if (settings.subscription && !new RegExp(`^projects/${settings.projectId}/subscriptions/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$`).test(settings.subscription)) throw new Error('料金通知のサブスクリプションは指定プロジェクト内のものを入力してください。');
  return settings;
}
function jstDate(instant) { return new Date(new Date(instant).getTime() + 9 * 3600000).toISOString().slice(0,10); }
function safeFilename(title, instant) {
  let clean = String(title).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '').trim();
  clean = Array.from(clean).slice(0,100).join('') || '動画';
  return `${jstDate(instant)}-${clean}.md`;
}
function makeIntervals(duration, size = 1200) {
  if (!Number.isInteger(duration) || duration <= 0 || duration > 7200) throw new Error('動画の長さは2時間以内である必要があります。');
  const intervals=[];
  for (let start = 0; start < duration; start += size) intervals.push({start, end: Math.min(duration,start+size), inputStart: Math.max(0,start-5), inputEnd: Math.min(duration,start+size+5)});
  return intervals;
}
function validateTranscript(data) {
  if (data?.audio_accessible !== true) throw new Error('動画の音声を取得できませんでした。公開状態を確認してください。');
  if (data.complete !== true || !Array.isArray(data.paragraphs) || !data.paragraphs.length) throw new Error('最後までの文字起こしが返りませんでした。再開してください。');
  if (data.paragraphs.length > 1000) throw new Error('応答の段落数が不正です。');
  let characters=0;
  return data.paragraphs.map(item => {
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('本文が空の段落が返りました。');
    characters += item.text.length;
    if (characters > 300000) throw new Error('本文が処理上限を超えました。');
    const heading = typeof item.heading === 'string' ? item.heading.trim().replace(/[\r\n]/g,' ') : '';
    if (heading.length > 60 || (heading && ![2,3].includes(item.level))) throw new Error('見出しの形式が不正です。');
    return {text:item.text.trim(),heading,level:heading ? item.level : 2};
  });
}
function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length < 5 || tags.length > 10 || tags.some(tag=>typeof tag!=='string' || !tag.trim() || tag.length>60 || /[\r\n]/.test(tag))) throw new Error('関連タグを5～10個取得できませんでした。再開してください。');
  const result=tags.map(tag=>tag.trim());
  if (new Set(result).size !== result.length) throw new Error('関連タグに重複があります。再開してください。');
  return result;
}
function renderMarkdown(metadata,startedAt,tags,paragraphs) {
  const lines=['---'];
  for (const [name,value] of Object.entries({title:metadata.title,source_url:metadata.url,channel:metadata.channel,published_at:metadata.publishedAt,transcribed_at:startedAt})) lines.push(`${name}: ${JSON.stringify(value)}`);
  lines.push('tags:', ...validateTags(tags).map(tag=>`  - ${JSON.stringify(tag)}`), '---','');
  for (const paragraph of paragraphs) {
    if(paragraph.heading) lines.push(`${'#'.repeat(paragraph.level)} ${paragraph.heading}`,'');
    lines.push(paragraph.text,'');
  }
  return lines.join('\n');
}
async function saveUnique(directory,filename,text) {
  await fs.mkdir(directory,{recursive:true});
  const temp=path.join(directory,`.videomd-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp,text,{encoding:'utf8',flag:'wx'});
    for(let number=1;number<=10000;number++) {
      const name=number===1 ? filename : filename.replace(/\.md$/,`-${number}.md`);
      const target=path.join(directory,name);
      try { await fs.link(temp,target); return target; }
      catch(error) { if(error.code!=='EEXIST') throw new Error('保存できませんでした。保存先には書き込み可能なローカルフォルダを選んでください。'); }
    }
    throw new Error('同名ファイルが多すぎます。保存先を変更してください。');
  } finally { await fs.unlink(temp).catch(()=>{}); }
}
function estimateUsd(model,usage,instant) {
  const rate=model==='gemini-3.5-flash-lite' ? [0.30,2.50] : new Date(instant) < new Date('2027-01-01T00:00:00Z') ? [0.75,3.75] : [1.50,7.50];
  return ((usage.promptTokenCount||0)*rate[0]+((usage.candidatesTokenCount||0)+(usage.thoughtsTokenCount||0))*rate[1])/1000000;
}
module.exports={MODELS,normalizeUrl,validateSettings,jstDate,safeFilename,makeIntervals,validateTranscript,validateTags,renderMarkdown,saveUnique,estimateUsd};
