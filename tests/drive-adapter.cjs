// Driveアダプタが業務Proと別の app / ファイル名を使い、許可したURLだけに投げること。実Driveには繋がない。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

function loadAdapter() {
    const calls = [];
    const transport = {
        state: () => ({ connected: true }),
        async appdataRequest(url, options, consume) {
            calls.push({ url, method: (options && options.method) || "GET", body: options && options.body, headers: options && options.headers });
            const fake = { json: async () => ({ files: [], id: "file-abc" }), text: async () => "{}" };
            return consume ? consume(fake) : fake;
        }
    };
    const ctx = vm.createContext({ console, URLSearchParams, Math, Date });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js/hw-drive-adapter.js"), "utf8"), ctx);
    const adapter = vm.runInContext("HwDriveAdapter.create({ transport: __t, channel: 'hw-parts-staging' })", Object.assign(ctx, { __t: transport }));
    const APP = vm.runInContext("HwDriveAdapter.APP", ctx);
    const PREFIX = vm.runInContext("HwDriveAdapter.PREFIX", ctx);
    return { adapter, calls, APP, PREFIX };
}

test("app名・ファイル名は業務Proと別", () => {
    const { APP, PREFIX } = loadAdapter();
    assert.equal(APP, "HWPartsDataSync1");
    assert.equal(PREFIX, "HWParts-data-");
    assert.ok(!APP.startsWith("CULOchan"));
    assert.ok(!PREFIX.startsWith("CULOchan"));
});

test("list は appDataFolder と HW の app/channel だけを問い合わせる", async () => {
    const { adapter, calls } = loadAdapter();
    await adapter.list();
    assert.equal(calls.length, 1);
    const u = calls[0].url;
    assert.ok(u.startsWith("https://www.googleapis.com/drive/v3/files?"));
    assert.ok(u.includes("spaces=appDataFolder") || u.includes("spaces=appDataFolder".replace("=", "%3D")) || /spaces=appDataFolder/.test(decodeURIComponent(u)));
    const decoded = decodeURIComponent(u);
    assert.ok(decoded.includes("HWPartsDataSync1"));
    assert.ok(decoded.includes("hw-parts-staging"));
    assert.ok(!decoded.includes("CULOchan"));
    assert.ok(!decoded.includes("gyomupro"));
});

test("write の新規作成は HWParts-data- の名前と appDataFolder 親", async () => {
    const { adapter, calls } = loadAdapter();
    const r = await adapter.write({ fileId: null, deviceId: "aaaaaaaa-0000-4000-8000-000000000001", savedAt: "2026-11-13T00:00:00.000Z", text: "{\"ok\":1}" });
    assert.equal(r.id, "file-abc");
    const w = calls.find(c => c.method === "POST");
    assert.ok(w);
    assert.ok(w.url.startsWith("https://www.googleapis.com/upload/drive/v3/files"));
    assert.ok(w.body.includes("HWParts-data-aaaaaaaa-0000-4000-8000-000000000001.json"));
    assert.ok(w.body.includes("appDataFolder"));
    assert.ok(w.body.includes("HWPartsDataSync1"));
    assert.ok(!w.body.includes("CULOchan"));
});
