/* ───────────────────────────────────────────────────────────────────────────
   PULVBALL BACKEND  v1.3.0
   Ein Cloudflare Worker für zwei Dinge: die Bestenliste und die Soundsets.

   Was er kann
     GET  /scores            die besten 50, als JSON
     POST /scores            {name, score, level, set}  trägt einen Lauf ein
     GET  /sets              die Liste der geteilten Sets, ohne Inhalt
     GET  /sets/<id>         ein einzelnes Set mit allen Reglerwerten
     POST /sets              {name, author, slots}      teilt ein Set

   Was er braucht, in den Einstellungen des Workers
     KV-Namespace unter dem Namen  PULV

   Das Wort, mit dem das Spiel schreiben darf, steht gleich hier unten als
   KEY. Wer lieber eine Variable im Dashboard setzt, nennt sie PULV_KEY,
   die hat dann Vorrang.

   Wer schreiben will, muss PULV_KEY im Kopf x-pulv-key mitschicken. Das hält
   Gelegenheitsunfug ab, mehr nicht, denn das Wort steht im Spiel und damit im
   Quelltext. Gegen gefälschte Punktzahlen hilft es nicht, dagegen hilft nur
   Nachrechnen auf dem Server, und das tut dieser Worker nicht.

   Namen werden geprüft, wenn das Spiel einen Audiotool-Token mitschickt. Dann
   fragt der Worker bei Audiotool nach, wem der Token gehört, und schreibt
   diesen Namen, nicht den eingetippten.
   ─────────────────────────────────────────────────────────────────────────── */

/* ▼▼▼ HIER steht das Wort, das auch im Spiel eingetragen wird ▼▼▼ */
const KEY = "pulvball-snad-2026";
/* ▲▲▲ ändern erlaubt, dann aber auch im Spiel ändern ▲▲▲ */

/* ▼▼▼ Und hier dein Admin-Wort. Das steht NICHT im Spiel, nur in der
       Admin-Seite, die du dir lokal hinlegst. Unbedingt ändern. ▼▼▼ */
const ADMIN = "snad-admin-bitte-aendern";
/* ▲▲▲ wer das hat, kann loeschen und sperren ▲▲▲ */

const TOP = 50;              // so viele Läufe bleiben in der Liste stehen
const MAX_SETS = 200;        // so viele Sets werden aufbewahrt
const MAX_SCORE = 50000000;  // alles darüber ist kein Spiel mehr gewesen
const MAX_SET_BYTES = 8192;  // ein Set ist eine Handvoll Zahlen, nicht mehr

const SLOTS = ["bumper","sling","flip","wall","target","fieldOff","mult","knobFull",
  "level","rampIn","rampOut","launch","drain","over","nudge","tilt"];
// jeder Regler hat seinen eigenen Bereich, genau wie im Panel
const RANGE = { level: [0, 2], tune: [-24, 24], attack: [0, 0.3], decay: [0.2, 3], filter: [0, 8000] };
const CTRL = ["level","tune","attack","decay","filter","wave","sample"];

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-pulv-key,x-pulv-token,x-pulv-admin",
  "access-control-max-age": "86400"
};
const json = (data, status) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors }
});
const bad = (msg, status) => json({ error: msg }, status || 400);

const clean = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

/* Audiotool sagt uns, wem ein Token gehört. Schlägt es fehl, gilt der Lauf
   als ungeprüft, er fliegt deswegen nicht raus. */
async function rpc(token, weg, body) {
  try {
    const r = await fetch("https://rpc.audiotool.com/" + weg, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
/* Zwei Namen, und beide werden gebraucht. Angezeigt wird, wie die Leute
   sich auf Audiotool nennen. Erkannt und gesperrt wird am Konto, denn den
   angezeigten Namen kann jeder jederzeit aendern. */
async function whoami(token) {
  if (!token) return null;
  const who = await rpc(token, "audiotool.auth.v1.AuthService/GetWhoami", {});
  const res = who && who.whoami && who.whoami.userName;     // "users/sandburgen"
  if (!res) return null;
  const konto = clean(String(res).replace(/^users\//i, ""), 24).toLowerCase();
  const got = await rpc(token, "audiotool.user.v1.UserService/GetUser", { name: res });
  const zeige = got && got.user && got.user.displayName;
  return { konto: konto, zeige: clean(zeige || konto, 24).toUpperCase() };
}

/* ---------- gesperrte Namen ---------- */

async function blockedList(env) {
  const raw = await env.PULV.get("blocked");
  return raw ? JSON.parse(raw) : [];
}
async function isBlocked(env, konto) {
  const l = await blockedList(env);
  return l.includes(String(konto || "").toLowerCase());
}

/* ---------- Bestenliste ---------- */

async function getScores(env) {
  const raw = await env.PULV.get("scores");
  return json({ scores: raw ? JSON.parse(raw) : [] });
}

async function postScore(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return bad("kein json");

  const score = Math.floor(Number(body.score));
  if (!isFinite(score) || score <= 0 || score > MAX_SCORE) return bad("punktzahl unglaubwürdig");

  const level = Math.max(1, Math.min(99, Math.floor(Number(body.level) || 1)));

  // Auf die weltweite Liste kommt nur, wer angemeldet ist. Das Spiel selbst
  // laeuft ohne Anmeldung weiter, der Lauf bleibt dann im eigenen Browser.
  const wer = await whoami(req.headers.get("x-pulv-token"));
  if (!wer) return bad("sign in with audiotool to enter the world board", 401);
  if (await isBlocked(env, wer.konto)) return bad("this account is blocked", 403);
  const name = wer.zeige;

  const raw = await env.PULV.get("scores");
  const list = raw ? JSON.parse(raw) : [];

  // derselbe Lauf zweimal geschickt, das zählt einmal
  const dup = list.some(e => e.name === name && e.score === score && Date.now() - e.at < 60000);
  if (!dup) {
    list.push({ name, who: wer.konto, score, level, set: clean(body.set, 14), ok: true, at: Date.now() });
    list.sort((a, b) => b.score - a.score);
    if (list.length > TOP) list.length = TOP;
    await env.PULV.put("scores", JSON.stringify(list));
  }
  const rank = list.findIndex(e => e.name === name && e.score === score);
  return json({ ok: true, rank: rank < 0 ? 0 : rank + 1, scores: list });
}

/* ---------- Soundsets ---------- */

/* Ein Set darf nur das enthalten, was das Spiel kennt. Alles andere fällt
   weg, damit niemand über diesen Weg etwas in die Seite bekommt. */
function tidySet(slots) {
  const out = {};
  if (!slots || typeof slots !== "object") return out;
  for (const k of SLOTS) {
    const s = slots[k];
    if (!s || typeof s !== "object") continue;
    const o = {};
    for (const c of CTRL) {
      if (s[c] === undefined) continue;
      if (c === "wave") { if (["","square","sawtooth","triangle","sine"].includes(s[c])) o.wave = s[c]; }
      else if (c === "sample") {
        const nm = s.sample && clean(s.sample.name, 80);
        if (nm && nm.startsWith("samples/")) o.sample = { name: nm, label: clean(s.sample.label, 40) };
      }
      else {
        const v = Number(s[c]), r = RANGE[c];
        if (isFinite(v) && r) o[c] = Math.max(r[0], Math.min(r[1], v));
      }
    }
    if (Object.keys(o).length) out[k] = o;
  }
  return out;
}

async function getSets(env) {
  const raw = await env.PULV.get("sets");
  return json({ sets: raw ? JSON.parse(raw) : [] });
}

async function getSet(env, id) {
  const raw = await env.PULV.get("set:" + id);
  if (!raw) return bad("kein set unter dieser kennung", 404);
  return json(JSON.parse(raw));
}

async function postSet(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return bad("kein json");

  const name = clean(body.name, 14).toUpperCase();
  if (!name) return bad("das set braucht einen namen");

  const slots = tidySet(body.slots);
  if (!Object.keys(slots).length) return bad("in dem set ist nichts verstellt");

  const wer = await whoami(req.headers.get("x-pulv-token"));
  if (!wer) return bad("sign in with audiotool to share a set", 401);
  if (await isBlocked(env, wer.konto)) return bad("this account is blocked", 403);
  const author = wer.zeige;
  const set = { id: "s" + Date.now().toString(36), name, author, who: wer.konto,
                ok: true, at: Date.now(), slots };

  const payload = JSON.stringify(set);
  if (payload.length > MAX_SET_BYTES) return bad("das set ist zu groß");

  const raw = await env.PULV.get("sets");
  const index = raw ? JSON.parse(raw) : [];
  index.unshift({ id: set.id, name, author, who: wer.konto, ok: true, at: set.at });
  if (index.length > MAX_SETS) index.length = MAX_SETS;

  await env.PULV.put("set:" + set.id, payload);
  await env.PULV.put("sets", JSON.stringify(index));
  return json({ ok: true, id: set.id, sets: index });
}

/* ---------- Aufsicht ----------
   Alles hinter einem zweiten Wort, das nur du hast. Ein Weg, vier Befehle. */

async function admin(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return bad("kein json");
  const act = String(body.action || "");

  if (act === "list") {
    const [sc, se, bl] = await Promise.all([
      env.PULV.get("scores"), env.PULV.get("sets"), env.PULV.get("blocked")
    ]);
    return json({ scores: sc ? JSON.parse(sc) : [], sets: se ? JSON.parse(se) : [],
                  blocked: bl ? JSON.parse(bl) : [] });
  }

  if (act === "set") {
    const id = clean(body.id, 40);
    const raw = await env.PULV.get("set:" + id);
    if (!raw) return bad("kein set unter dieser kennung", 404);
    return json(JSON.parse(raw));
  }

  if (act === "delSet") {
    const id = clean(body.id, 40);
    await env.PULV.delete("set:" + id);
    const raw = await env.PULV.get("sets");
    const index = (raw ? JSON.parse(raw) : []).filter(e => e.id !== id);
    await env.PULV.put("sets", JSON.stringify(index));
    return json({ ok: true, sets: index });
  }

  if (act === "delScore") {
    const name = clean(body.name, 24).toUpperCase();
    const score = Math.floor(Number(body.score));
    const raw = await env.PULV.get("scores");
    const list = (raw ? JSON.parse(raw) : []).filter(e => !(e.name === name && e.score === score));
    await env.PULV.put("scores", JSON.stringify(list));
    return json({ ok: true, scores: list });
  }

  if (act === "block" || act === "unblock") {
    // gesperrt wird das Konto, nicht der angezeigte Name
    const konto = clean(body.who || body.name, 24).toLowerCase();
    if (!konto) return bad("kein konto");
    let list = await blockedList(env);
    if (act === "block") { if (!list.includes(konto)) list.push(konto); }
    else list = list.filter(n => n !== konto);
    await env.PULV.put("blocked", JSON.stringify(list));
    if (act === "block") {
      const passt = e => String(e.who || "").toLowerCase() === konto;
      const rs = await env.PULV.get("scores");
      if (rs) await env.PULV.put("scores", JSON.stringify(JSON.parse(rs).filter(e => !passt(e))));
      const xs = await env.PULV.get("sets");
      if (xs) {
        const alle = JSON.parse(xs);
        for (const g of alle.filter(passt)) await env.PULV.delete("set:" + g.id);
        await env.PULV.put("sets", JSON.stringify(alle.filter(e => !passt(e))));
      }
    }
    return json({ ok: true, blocked: list });
  }

  return bad("unbekannter befehl");
}

/* ---------- Tür ---------- */

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.PULV) return bad("der speicher PULV ist nicht verbunden", 500);

    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET") {
      if (path === "/" ) return json({ pulvball: "ok", version: "1.3.0" });
      if (path === "/scores") return getScores(env);
      if (path === "/sets") return getSets(env);
      if (path.startsWith("/sets/")) return getSet(env, clean(path.slice(6), 40));
      return bad("unbekannter weg", 404);
    }

    if (req.method === "POST") {
      if (path === "/admin") {
        const akey = env.PULV_ADMIN || ADMIN;
        if (!akey || req.headers.get("x-pulv-admin") !== akey) return bad("falscher schlüssel", 403);
        return admin(req, env);
      }
      const key = env.PULV_KEY || KEY;
      if (key && req.headers.get("x-pulv-key") !== key) return bad("falscher schlüssel", 403);
      if (path === "/scores") return postScore(req, env);
      if (path === "/sets") return postSet(req, env);
      return bad("unbekannter weg", 404);
    }

    return bad("so nicht", 405);
  }
};
