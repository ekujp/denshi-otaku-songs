// 曲の候補を集めて、songs テーブルに「承認待ち(pending)」で追加する
import { createClient } from "@supabase/supabase-js";

const LASTFM = process.env.LASTFM_API_KEY;
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_NEW = Number(process.env.MAX_NEW || 20);   // 1回に追加する候補の上限
const SEEDS = Number(process.env.SEEDS || 12);       // 1回に調べるアーティスト数
if (!LASTFM || !SB_URL || !SB_KEY) { console.error("Secrets が足りません"); process.exit(1); }

const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[\s()\[\]（）「」『』!！?？.,、。~〜…_\-:：/'"*・·]/g, "");
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

async function lf(method, params) {
  const u = new URL("https://ws.audioscrobbler.com/2.0/");
  u.search = new URLSearchParams({ method, api_key: LASTFM, format: "json", ...params });
  try {
    const r = await fetch(u, { headers: { "User-Agent": "denshi-songs-collector/1.0" } });
    await sleep(300);
    if (!r.ok) return null;
    const j = await r.json();
    return j.error ? null : j;
  } catch { return null; }
}

// 1) いまある曲(承認待ち・却下済みも含む)を全部読む
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("songs").select("title,artist,artist_group,status").range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
}
const known = new Set(rows.map((r) => norm(r.title) + "|" +
