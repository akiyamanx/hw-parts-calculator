// [端末間の自動同期] HW部材・過去の集計、一般マスター、見積/請求、自社情報を揃える。
// 仕組みは業務Proと同じ: Drive のアプリ専用領域に「端末ごとに1ファイル」を置き、読むときに全部を合わせる。
//   ・1件ごとに固定のキー（部材id、集計id、書類id）。
//   ・項目ごとに「最後に変えた方が勝つ」。別の項目を別の端末で直した場合は両方残る。
//   ・削除は削除の印（時刻）として残し、他端末へ伝える。
//   ・この端末の変更は、前回同期時の各項目の要約（ハッシュ）と見比べて見つける。
//   ・初回（両端末ともデータあり）は置き換えずに合わせる。初回の時刻は「不明(1)」とし、以後の本当の編集が必ず勝つ。
// 同期しないもの（端末ごと）: 工事価格表(hw_price_table_v1)、画面の開閉、最後に選んだモード、
//   接続用ID・トークン、同期の内部記録、各種バックアップ控え。
// トークンは扱わない（通信は adapter）。ログに中身は出さない（コードだけ）。
const HwDataSync = (() => {
    const APP = "HWPartsDataSync1", V = 1, STATE_KEY = "hwParts.dataSync.v1";
    const BACKUP_KEY = "hwParts.backup.beforeDriveSync.v1";
    const MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_FILES = 20;
    const TOMB_KEEP_MS = 180 * 24 * 3600 * 1000, FUTURE_MS = 7 * 24 * 3600 * 1000;
    const BASE_T = 1;
    const LOGO_MAX = 450000;
    const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const KEY_RE = /^[\w.@:|-]{1,160}$/;
    const FIELD_RE = /^[A-Za-z_$][\w$-]{0,60}$/;
    const BAD_FIELD = /^(?:__proto__|prototype|constructor|apiKey|geminiApiKey|access_token|refresh_token|client_secret|password|token)$|imageDataUrl$/i;
    const COLLS = ["hwMat", "hwJob", "hwMeta", "hwParty", "genMat", "genMeta", "genDoc", "genSet"];
    const ITEM_COLLS = ["hwMat", "hwJob", "genMat", "genDoc"];
    const WORK_KEY = "hwParts.workState.v1";
    const PP_KEY = "hwParts.printParties.v1";
    const GEN_KEY = "genParts.workState.v1";
    const GEN_SET_KEY = "genParts.settings.v1";
    const GEN_DOCS_KEY = "genParts.docs.v1";
    const DATA_KEYS = [WORK_KEY, PP_KEY, GEN_KEY, GEN_SET_KEY, GEN_DOCS_KEY];
    const HW_META_FIELDS = ["taxRate", "nextId", "round", "dupIgnore", "lastUse", "imp", "lastImp", "history", "catMig", "catUndo", "priceRev", "v"];
    const GEN_META_FIELDS = ["nextId", "kind", "copiedFrom", "copiedFromHwAt", "v"];
    const SET_FIELDS = ["name", "person", "postal", "address", "tel", "fax", "email", "bank", "logo", "invoiceReg", "round"];
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const hashOf = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + s.length.toString(36); };
    const enc = v => v === undefined ? "~" : JSON.stringify(v);
    const hv = v => hashOf(enc(v));
    const empty = v => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    const fail = code => Object.assign(new Error(code), { code });
    const strMax = (name) => name === "logo" ? LOGO_MAX : 20000;

    function cleanValue(v, depth, field) {
        if (v === null || typeof v === "boolean") return v;
        if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
        if (typeof v === "string") return v.length <= strMax(field) ? v : undefined;
        if (depth > 10) return undefined;
        if (Array.isArray(v)) {
            if (v.length > 3000) return undefined;
            const out = [];
            for (const x of v) { const c = cleanValue(x, depth + 1, field); if (c === undefined) return undefined; out.push(c); }
            return out;
        }
        if (isObj(v)) {
            const out = {}; const ks = Object.keys(v); if (ks.length > 300) return undefined;
            for (const k of ks) {
                if (BAD_FIELD.test(k) || k.length > 200) return undefined;
                const c = cleanValue(v[k], depth + 1, k === "logo" ? "logo" : field);
                if (c === undefined) return undefined;
                out[k] = c;
            }
            return out;
        }
        return undefined;
    }
    const tsOk = (t, now) => Number.isInteger(t) && t >= 0 && t <= now + FUTURE_MS;
    const keyOk = (coll, key) => typeof key === "string" && KEY_RE.test(key) && !BAD_FIELD.test(key)
        && ((coll === "hwMeta" && key === "work") || (coll === "hwParty" && key === "print") || (coll === "genMeta" && key === "work") || (coll === "genSet" && key === "company") || ITEM_COLLS.indexOf(coll) >= 0);

    function parseDoc(text, expectedDeviceId, now) {
        if (typeof text !== "string") return { ok: false, code: "bad_format" };
        if (text.length > MAX_FILE_BYTES) return { ok: false, code: "file_too_large" };
        let doc; try { doc = JSON.parse(text); } catch (e) { return { ok: false, code: "bad_json" }; }
        if (!isObj(doc) || doc.app !== APP) return { ok: false, code: "bad_format" };
        if (doc.v !== V) return { ok: false, code: "newer_version" };
        if (!DEVICE_RE.test(String(doc.deviceId)) || (expectedDeviceId && doc.deviceId !== expectedDeviceId)) return { ok: false, code: "bad_device" };
        if (!isObj(doc.recs)) return { ok: false, code: "bad_format" };
        const recs = {}; let dropped = 0;
        for (const coll of COLLS) {
            recs[coll] = new Map();
            const src = doc.recs[coll]; if (src === undefined) continue;
            if (!isObj(src)) { dropped++; continue; }
            for (const key of Object.keys(src)) {
                const r = src[key];
                if (!keyOk(coll, key) || !isObj(r) || !tsOk(r.a, now) || (r.d !== undefined && !tsOk(r.d, now)) || (r.f !== undefined && !isObj(r.f))) { dropped++; continue; }
                const f = {}; let bad = false;
                for (const name of Object.keys(r.f || {})) {
                    const e = r.f[name];
                    if (!FIELD_RE.test(name) || BAD_FIELD.test(name) || !Array.isArray(e) || e.length < 1 || e.length > 2 || !tsOk(e[0], now)) { bad = true; break; }
                    const v = e.length === 2 ? cleanValue(e[1], 0, name) : undefined;
                    if (e.length === 2 && v === undefined) { bad = true; break; }
                    f[name] = { t: e[0], v, h: hv(v) };
                }
                if (bad) { dropped++; continue; }
                recs[coll].set(key, { a: r.a, d: r.d || 0, f });
            }
        }
        return { ok: true, deviceId: doc.deviceId, recs, dropped };
    }

    function create(opts) {
        const o = opts || {};
        const S = o.storage, adapter = o.adapter;
        if (!S || typeof S.getItem !== "function") throw new Error("storage required");
        const nowMs = () => (o.now ? o.now() : new Date()).getTime();
        const uuid = () => {
            try { const v = o.uuid ? o.uuid() : (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : ""); if (DEVICE_RE.test(v)) return v; } catch (e) { /* 下で作る */ }
            const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
            return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
        };
        const timeoutMs = o.timeoutMs || 30000;
        let running = null, last = { ok: null, code: "", at: 0, stats: null };

        function loadState() {
            const raw = S.getItem(STATE_KEY);
            if (!raw) return { v: 1, deviceId: uuid(), clocks: null, fileId: null, pushHash: "" };
            const st = JSON.parse(raw);
            if (!isObj(st) || !DEVICE_RE.test(String(st.deviceId))) throw fail("state_corrupt");
            return st;
        }
        const saveState = st => S.setItem(STATE_KEY, JSON.stringify(st));
        const readJson = (key, fallback, required) => {
            const raw = S.getItem(key);
            if (raw === null || raw === undefined) return fallback;
            let v;
            try { v = JSON.parse(raw); } catch (e) { throw fail("local_corrupt"); }
            return v;
        };

        function putRecs(out, coll, recs) {
            for (const [key, raw] of recs) {
                if (!KEY_RE.test(String(key))) continue;
                out[coll].set(String(key), raw);
            }
        }
        function recFromObj(obj) {
            if (!isObj(obj)) return null;
            const r = {};
            for (const k of Object.keys(obj)) {
                if (!FIELD_RE.test(k) || BAD_FIELD.test(k)) continue;
                r[k] = obj[k];
            }
            return r;
        }
        function listById(arr, idName) {
            const out = [];
            if (!Array.isArray(arr)) return out;
            for (const item of arr) {
                if (!isObj(item) || item[idName] == null) continue;
                const id = String(item[idName]);
                if (!KEY_RE.test(id)) continue;
                const rec = recFromObj(item);
                if (rec) out.push([id, rec]);
            }
            return out;
        }

        function readLocal() {
            const out = {}; COLLS.forEach(c => { out[c] = new Map(); });
            const work = readJson(WORK_KEY, null);
            if (work !== null) {
                if (!isObj(work)) throw fail("local_corrupt");
                if (work.materials != null && !Array.isArray(work.materials)) throw fail("local_corrupt");
                if (work.jobs != null && !Array.isArray(work.jobs)) throw fail("local_corrupt");
                putRecs(out, "hwMat", listById(work.materials || [], "id"));
                putRecs(out, "hwJob", listById(work.jobs || [], "id"));
                const meta = {};
                for (const k of HW_META_FIELDS) if (has(work, k)) meta[k] = work[k];
                out.hwMeta.set("work", meta);
            }
            const pp = readJson(PP_KEY, null);
            if (pp !== null) {
                if (!isObj(pp)) throw fail("local_corrupt");
                out.hwParty.set("print", recFromObj(pp) || {});
            }
            const gen = readJson(GEN_KEY, null);
            if (gen !== null) {
                if (!isObj(gen)) throw fail("local_corrupt");
                if (gen.materials != null && !Array.isArray(gen.materials)) throw fail("local_corrupt");
                putRecs(out, "genMat", listById(gen.materials || [], "id"));
                const meta = {};
                for (const k of GEN_META_FIELDS) if (has(gen, k)) meta[k] = gen[k];
                out.genMeta.set("work", meta);
            }
            const set = readJson(GEN_SET_KEY, null);
            if (set !== null) {
                if (!isObj(set)) throw fail("local_corrupt");
                const flat = {};
                const c = isObj(set.company) ? set.company : {};
                for (const k of SET_FIELDS) {
                    if (k === "invoiceReg" || k === "round") { if (has(set, k)) flat[k] = set[k]; }
                    else if (has(c, k)) flat[k] = c[k];
                }
                out.genSet.set("company", flat);
            }
            const docs = readJson(GEN_DOCS_KEY, null);
            if (docs !== null) {
                if (!Array.isArray(docs)) throw fail("local_corrupt");
                putRecs(out, "genDoc", listById(docs, "id"));
            }
            return { out };
        }

        const sanitize = rec => {
            const r = {};
            for (const k of Object.keys(rec)) {
                if (!FIELD_RE.test(k) || BAD_FIELD.test(k)) continue;
                const v = cleanValue(rec[k], 0, k);
                if (v !== undefined) r[k] = v;
            }
            return r;
        };

        function stamp(local, clocks, now, first) {
            const view = {}; const deleted = { items: [] };
            COLLS.forEach(c => { view[c] = new Map(); });
            for (const coll of COLLS) {
                const cl = clocks[coll] || {};
                for (const [key, raw] of local.out[coll]) {
                    const rec = sanitize(raw);
                    const prev = has(cl, key) ? cl[key] : null;
                    const f = {};
                    const t0 = first || !prev ? (first ? BASE_T : now) : now;
                    for (const name of Object.keys(rec)) {
                        const h = hv(rec[name]); const p = prev && prev.f && prev.f[name];
                        f[name] = { t: p && p[1] === h ? p[0] : t0, v: rec[name], h };
                    }
                    if (prev && prev.f) for (const name of Object.keys(prev.f)) if (!has(rec, name)) {
                        const p = prev.f[name]; f[name] = { t: p[1] === "~" ? p[0] : now, v: undefined, h: "~" };
                    }
                    let a = prev ? prev.a : (first ? BASE_T : now), d = prev ? (prev.d || 0) : 0;
                    if (d && d >= a && Math.max(a, ...Object.values(f).map(x => x.t)) <= d) a = now;
                    view[coll].set(key, { a, d, f });
                }
                for (const key of Object.keys(cl)) {
                    if (local.out[coll].has(key)) continue;
                    const p = cl[key]; const f = {};
                    for (const name of Object.keys(p.f || {})) f[name] = { t: p.f[name][0], v: undefined, h: p.f[name][1], unknown: true };
                    const isAlive = Math.max(p.a, ...Object.values(f).map(x => x.t)) > (p.d || 0);
                    const d = isAlive ? now : p.d;
                    if (isAlive && ITEM_COLLS.indexOf(coll) >= 0) deleted.items.push(coll + ":" + key);
                    view[coll].set(key, { a: p.a, d, f, gone: true });
                }
            }
            return { view, deleted };
        }

        const winField = (x, y) => {
            if (!x) return y; if (!y) return x;
            if (x.unknown && !y.unknown && x.t <= y.t) return y;
            if (y.unknown && !x.unknown && y.t <= x.t) return x;
            if (x.t !== y.t) return x.t > y.t ? x : y;
            if (empty(x.v) !== empty(y.v)) return empty(x.v) ? y : x;
            return x.h >= y.h ? x : y;
        };
        const maxT = r => Math.max(r.a, ...Object.values(r.f).map(x => x.t));
        const alive = r => maxT(r) > (r.d || 0);
        function mergeRec(x, y, conflicts) {
            if (!x) return y; if (!y) return x;
            const f = {};
            for (const name of new Set([...Object.keys(x.f), ...Object.keys(y.f)])) {
                const a = x.f[name], b = y.f[name];
                if (a && b && a.t === BASE_T && b.t === BASE_T && a.h !== b.h && conflicts) conflicts.n++;
                f[name] = winField(a, b);
            }
            return { a: Math.min(x.a, y.a) || Math.max(x.a, y.a), d: Math.max(x.d || 0, y.d || 0), f };
        }

        const plain = r => { const o2 = {}; for (const n of Object.keys(r.f)) if (r.f[n].v !== undefined) o2[n] = r.f[n].v; return o2; };
        function ordered(list, prevIds) {
            const pos = new Map((prevIds || []).map((k, i) => [String(k), i]));
            return list.sort((p, q) => (pos.has(p.key) ? pos.get(p.key) : 1e9) - (pos.has(q.key) ? pos.get(q.key) : 1e9) || String(p.key).localeCompare(String(q.key)));
        }
        function recList(viewColl, prevIds, forceId) {
            const list = [];
            for (const [key, r] of viewColl) {
                if (!alive(r)) continue;
                const c = plain(r);
                if (forceId && c.id === undefined) c.id = isFinite(Number(key)) && String(Number(key)) === key ? Number(key) : key;
                list.push({ key, c });
            }
            return ordered(list, prevIds).map(x => x.c);
        }

        function applyView(view, local) {
            const write = (key, value) => {
                const s = JSON.stringify(value);
                if (S.getItem(key) === s) return 0;
                S.setItem(key, s);
                return 1;
            };
            let writes = 0;
            const hasHw = (view.hwMat.size + view.hwJob.size + view.hwMeta.size) > 0 || S.getItem(WORK_KEY) != null;
            if (hasHw) {
                let prev = {};
                try { prev = readJson(WORK_KEY, {}) || {}; } catch (e) { prev = {}; }
                if (!isObj(prev)) prev = {};
                const mats = recList(view.hwMat, (prev.materials || []).map(m => m && m.id), true);
                const jobs = recList(view.hwJob, (prev.jobs || []).map(j => j && j.id), true);
                const metaR = view.hwMeta.get("work");
                const meta = metaR && alive(metaR) ? plain(metaR) : {};
                const next = { ...prev, ...meta, materials: mats, jobs };
                if (!next.v) next.v = 3;
                next.savedAt = new Date(nowMs()).toISOString();
                const maxMat = mats.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
                next.nextId = Math.max(Number(next.nextId) || 0, maxMat + 1);
                writes += write(WORK_KEY, next);
            }
            const partyR = view.hwParty.get("print");
            if (partyR && alive(partyR)) writes += write(PP_KEY, plain(partyR));
            const hasGen = view.genMat.size + view.genMeta.size > 0 || S.getItem(GEN_KEY) != null;
            if (hasGen) {
                let prev = {};
                try { prev = readJson(GEN_KEY, {}) || {}; } catch (e) { prev = {}; }
                if (!isObj(prev)) prev = {};
                const mats = recList(view.genMat, (prev.materials || []).map(m => m && m.id), true);
                const metaR = view.genMeta.get("work");
                const meta = metaR && alive(metaR) ? plain(metaR) : {};
                const next = { ...prev, ...meta, kind: meta.kind || prev.kind || "general", materials: mats };
                next.savedAt = new Date(nowMs()).toISOString();
                const maxMat = mats.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
                next.nextId = Math.max(Number(next.nextId) || 0, maxMat + 1);
                writes += write(GEN_KEY, next);
            }
            const setR = view.genSet.get("company");
            if (setR && alive(setR)) {
                let prev = {};
                try { prev = readJson(GEN_SET_KEY, {}) || {}; } catch (e) { prev = {}; }
                if (!isObj(prev)) prev = {};
                const flat = plain(setR);
                const company = { ...(isObj(prev.company) ? prev.company : {}) };
                for (const k of SET_FIELDS) {
                    if (k === "invoiceReg" || k === "round") continue;
                    if (has(flat, k)) company[k] = flat[k];
                }
                const next = { v: 1, company };
                if (has(flat, "invoiceReg")) next.invoiceReg = flat.invoiceReg;
                else if (typeof prev.invoiceReg === "string") next.invoiceReg = prev.invoiceReg;
                else next.invoiceReg = "";
                if (has(flat, "round")) next.round = flat.round;
                else next.round = prev.round || "floor";
                writes += write(GEN_SET_KEY, next);
            }
            const hasDocs = view.genDoc.size > 0 || S.getItem(GEN_DOCS_KEY) != null;
            if (hasDocs) {
                let prev = [];
                try { prev = readJson(GEN_DOCS_KEY, []) || []; } catch (e) { prev = []; }
                if (!Array.isArray(prev)) prev = [];
                const docs = recList(view.genDoc, prev.map(d => d && d.id), true).slice(0, 300);
                writes += write(GEN_DOCS_KEY, docs);
            }
            return writes;
        }

        function clocksOf(view, now) {
            const cl = {};
            for (const coll of COLLS) {
                cl[coll] = {};
                for (const [key, r] of view[coll]) {
                    if (!alive(r) && now - r.d > TOMB_KEEP_MS) continue;
                    const f = {}; if (alive(r)) for (const n of Object.keys(r.f)) f[n] = [r.f[n].t, r.f[n].h];
                    cl[coll][key] = alive(r) ? { a: r.a, f } : { a: r.a, d: r.d, f };
                }
            }
            return cl;
        }
        function docOf(view, deviceId, savedAt, now) {
            const recs = {};
            for (const coll of COLLS) {
                recs[coll] = {};
                for (const [key, r] of view[coll]) {
                    if (alive(r)) { const f = {}; for (const n of Object.keys(r.f)) f[n] = r.f[n].v === undefined ? [r.f[n].t] : [r.f[n].t, r.f[n].v]; recs[coll][key] = { a: r.a, f }; }
                    else if (now - r.d <= TOMB_KEEP_MS) recs[coll][key] = { a: r.a, d: r.d };
                }
            }
            return { app: APP, v: V, deviceId, savedAt, recs };
        }

        function defaultBackup() {
            if (S.getItem(BACKUP_KEY)) return;
            const snap = { at: new Date(nowMs()).toISOString(), keys: {} };
            for (const k of DATA_KEYS) { const v = S.getItem(k); if (v != null) snap.keys[k] = v; }
            S.setItem(BACKUP_KEY, JSON.stringify(snap));
        }
        function exportBeforeSync() {
            const raw = S.getItem(BACKUP_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        }
        const aliveCount = clocks => {
            let n = 0;
            for (const coll of ITEM_COLLS) for (const k of Object.keys((clocks && clocks[coll]) || {})) if (!(clocks[coll][k] && clocks[coll][k].d)) n++;
            return n;
        };

        const withTimeout = (p) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(fail("timeout")), timeoutMs); p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });
        const errCode = e => e && typeof e.code === "string" && /^[a-z_]{1,40}$/.test(e.code) ? e.code : "unexpected";

        async function syncOnce(opt) {
            const op = opt || {};
            if (!adapter || !adapter.available || !adapter.available().connected) return { ok: false, code: "not_connected" };
            const now = nowMs();
            let st, local;
            try { st = loadState(); local = readLocal(); } catch (e) { return { ok: false, code: e.code === "state_corrupt" ? "state_corrupt" : "local_corrupt" }; }
            const first = !st.clocks;
            if (first || op.massDelete === "restore") {
                if (!st.backupAt) {
                    try { if (typeof o.backup === "function") await o.backup(); else defaultBackup(); } catch (e) { return { ok: false, code: "backup_failed" }; }
                    st.backupAt = new Date(now).toISOString(); saveState(st);
                }
            }
            const clocks = st.clocks || {};
            if (op.massDelete === "restore") for (const coll of COLLS) for (const k of Object.keys(clocks[coll] || {})) if (!local.out[coll].has(k)) delete clocks[coll][k];
            const { view, deleted } = stamp(local, clocks, now, first);
            const aliveBefore = aliveCount(clocks);
            if (!first && op.massDelete !== "allow" && deleted.items.length >= 5 && deleted.items.length > aliveBefore * 0.3) {
                return { ok: false, code: "mass_delete", count: deleted.items.length };
            }
            let files;
            try { files = await withTimeout(adapter.list()); } catch (e) { return { ok: false, code: errCode(e) }; }
            const mine = files.filter(f => f.deviceId === st.deviceId);
            const others = files.filter(f => f.deviceId !== st.deviceId && DEVICE_RE.test(String(f.deviceId))).slice(0, MAX_FILES);
            const warnings = []; let dropped = 0;
            const conflicts = { n: 0 };
            let added = 0, changed = 0;
            for (const f of others) {
                let doc;
                try { doc = parseDoc(await withTimeout(adapter.read(f)), f.deviceId, now); } catch (e) { warnings.push("file_unreadable"); continue; }
                if (!doc.ok) { warnings.push(doc.code === "newer_version" ? "newer_version" : "file_invalid"); continue; }
                dropped += doc.dropped;
                for (const coll of COLLS) for (const [key, r] of doc.recs[coll]) {
                    const cur = view[coll].get(key);
                    if (!cur) { if (alive(r)) { if (ITEM_COLLS.indexOf(coll) >= 0) added++; } view[coll].set(key, r); continue; }
                    const m = mergeRec(cur, r, first ? conflicts : null);
                    if (ITEM_COLLS.indexOf(coll) >= 0 && hashOf(JSON.stringify(m)) !== hashOf(JSON.stringify(cur))) changed++;
                    view[coll].set(key, m);
                }
            }
            if (dropped) warnings.push("records_dropped");
            let again; try { again = readLocal(); } catch (e) { return { ok: false, code: "local_corrupt" }; }
            for (const coll of COLLS) {
                if (again.out[coll].size !== local.out[coll].size) return { ok: false, code: "busy_local" };
                for (const [k, v] of again.out[coll]) if (!local.out[coll].has(k) || enc(sanitize(v)) !== enc(sanitize(local.out[coll].get(k)))) return { ok: false, code: "busy_local" };
            }
            let writes;
            try { writes = applyView(view, local); } catch (e) { return { ok: false, code: "write_failed" }; }
            st.clocks = clocksOf(view, now);
            try { const after = readLocal(); const re = stamp(after, st.clocks, now, false); st.clocks = clocksOf(re.view, now); } catch (e) { /* 次回やり直す */ }
            saveState(st);
            let pushed = false;
            const docText = JSON.stringify(docOf(view, st.deviceId, new Date(now).toISOString(), now));
            const ph = hashOf(docText.replace(/"savedAt":"[^"]*"/, ""));
            if (docText.length > MAX_FILE_BYTES) warnings.push("too_large");
            else if (ph !== st.pushHash || !mine.length) {
                try {
                    const fileId = (mine.find(f => f.id === st.fileId) || mine[0] || {}).id || null;
                    const res = await withTimeout(adapter.write({ fileId, deviceId: st.deviceId, savedAt: new Date(now).toISOString(), text: docText }));
                    const st2 = loadState(); st2.fileId = res && res.id || fileId; st2.pushHash = ph; saveState(st2); pushed = true;
                } catch (e) { warnings.push("push_failed"); }
            }
            const stats = { added, changed, deletedHere: deleted.items.length, writes, pushed, devices: others.length, conflicts: conflicts.n, first };
            return { ok: true, stats, warnings: [...new Set(warnings)] };
        }
        async function sync(opt) {
            if (running) return { ok: false, code: "busy" };
            running = syncOnce(opt).catch(() => ({ ok: false, code: "unexpected" }));
            try { const r = await running; last = { ok: r.ok, code: r.code || "", at: nowMs(), stats: r.stats || null, warnings: r.warnings || [], count: r.count }; return r; }
            finally { running = null; }
        }
        function fingerprint() {
            let s = "";
            for (const k of DATA_KEYS) { const v = S.getItem(k); s += k + "=" + hashOf(String(v == null ? "" : v)) + ";"; }
            return hashOf(s);
        }
        async function remoteSignature() {
            if (!adapter || !(adapter.available() || {}).connected) return { ok: false, code: "not_connected" };
            let me = ""; try { const st = JSON.parse(S.getItem(STATE_KEY) || "null"); me = st && st.deviceId || ""; } catch (e) { me = ""; }
            let files; try { files = await withTimeout(adapter.list()); } catch (e) { return { ok: false, code: errCode(e) }; }
            const sig = files.filter(f => f && f.deviceId !== me).map(f => [f.id, f.savedAt || "", f.modified || "", f.size || 0].join(":")).sort().join("|");
            return { ok: true, sig };
        }
        function checkpoint() {
            if (running) return { ok: false, code: "busy" };
            try {
                const st = loadState(); if (!st.clocks) return { ok: false, code: "not_started" };
                const local = readLocal();
                const now = nowMs();
                const { view, deleted } = stamp(local, st.clocks, now, false);
                const aliveBefore = aliveCount(st.clocks);
                if (deleted.items.length >= 5 && deleted.items.length > aliveBefore * 0.3) return { ok: false, code: "mass_delete", count: deleted.items.length };
                const next = clocksOf(view, now);
                if (JSON.stringify(next) !== JSON.stringify(st.clocks)) { st.clocks = next; saveState(st); return { ok: true, changed: true }; }
                return { ok: true, changed: false };
            } catch (e) { return { ok: false, code: e && e.code === "local_corrupt" ? "local_corrupt" : "local_corrupt" }; }
        }
        function rebase() { try { const st = loadState(); st.clocks = null; saveState(st); return true; } catch (e) { return false; } }
        function status() { let st = null; try { st = JSON.parse(S.getItem(STATE_KEY) || "null"); } catch (e) { st = null; } return { ...last, running: !!running, everSynced: !!(st && st.clocks), backupAt: st && st.backupAt || "" }; }
        return { sync, status, fingerprint, rebase, checkpoint, remoteSignature, exportBeforeSync };
    }
    return { create, parseDoc, APP, STATE_KEY, BACKUP_KEY, MAX_FILE_BYTES, DATA_KEYS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = HwDataSync;
