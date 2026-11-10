#!/usr/bin/env node
// Mode isolation and migration-safety tests (fictional prices only).
// Run: node tests/general-mode.js
// Needs: puppeteer-core and Chrome (PUPPETEER / CHROME env optional).
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const FILE = process.env.U || ("file://" + path.resolve(__dirname, "../hw-parts-calculator.html"));

// Fictional fixture only. Do not use production / xlsx prices here.
const HW_FIXTURE = {
  v: 3,
  priceRev: "2026-10-25",
  savedAt: "2026-11-01T00:00:00.000Z",
  taxRate: 10,
  nextId: 900,
  catMig: 1,
  materials: [
    { id: 801, cat: "テスト", name: "架空エルボ", size: "20A", mode: "piece", price: 11, packLen: 0, qty: 7, stock: 3, cnu: "個" },
    { id: 802, cat: "テスト", name: "架空パイプ", size: "1m", mode: "length", price: 22, packLen: 10, qty: 1.5, cnu: "m" }
  ],
  jobs: [{ id: "job-fic", site: "架空現場A", date: "2026-11-01", items: [], total: 0 }],
  history: []
};
const PP_FIXTURE = { title: "架空の集計タイトル", to: "架空の宛先", fromName: "架空の発行元", fromAddr: "架空の住所" };

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log("  OK  " + name);
  else {
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("  NG  " + name + (detail ? " :: " + detail : ""));
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-gpu"],
    headless: "new"
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function freshPage(seed) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(FILE);
    await wait(200);
    if (seed) {
      await page.evaluate((hw, pp, dummyTable) => {
        localStorage.setItem("hwParts.workState.v1", JSON.stringify(hw));
        localStorage.setItem("hwParts.printParties.v1", JSON.stringify(pp));
        localStorage.setItem("hw_price_table_v1", dummyTable);
      }, HW_FIXTURE, PP_FIXTURE, "DUMMY_NOT_A_REAL_TABLE");
      await page.reload({ waitUntil: "domcontentloaded" });
      await wait(300);
    }
    return { ctx, page, errs };
  }

  function lsDump(page) {
    return page.evaluate(() => {
      const g = (k) => localStorage.getItem(k);
      return {
        hw: g("hwParts.workState.v1"),
        pp: g("hwParts.printParties.v1"),
        pt: g("hw_price_table_v1"),
        gen: g("genParts.workState.v1"),
        bak: g("hwParts.backup.beforeGeneral.v1"),
        mode: g("appSelect.v1")
      };
    });
  }

  console.log("# A  start screen (no auto, no seed)");
  {
    const { ctx, page, errs } = await freshPage(false);
    const ui = await page.evaluate(() => ({
      gate: !!(document.getElementById("modeGate") && getComputedStyle(document.getElementById("modeGate")).display !== "none"),
      body: document.body.className,
      mode: window.__HW_APP__ && window.__HW_APP__.getMode(),
      hwWritten: localStorage.getItem("hwParts.workState.v1") != null,
      genWritten: localStorage.getItem("genParts.workState.v1") != null,
      title: document.title
    }));
    check("start screen visible", ui.gate && ui.mode === "pick" && ui.body.includes("mode-pick"));
    check("start screen does not write HW or general keys", !ui.hwWritten && !ui.genWritten);
    check("document title is 見積り・請求書", ui.title === "見積り・請求書");
    check("no page errors on start", errs.length === 0, errs.join(" | "));
    await ctx.close();
  }

  console.log("# B  first general init preserves HW keys byte-for-byte");
  {
    const { ctx, page, errs } = await freshPage(true);
    const before = await lsDump(page);
    await page.click("#mgGen");
    await wait(400);
    const after = await lsDump(page);
    const app = await page.evaluate(() => {
      const A = window.__HW_APP__;
      return {
        mode: A.getMode(),
        count: A.getMaterialCount(),
        n801: A.getName(801),
        q801: A.getQty(801),
        s801: A.getStock(801),
        p11: A.hasPrice(801, 11),
        p22: A.hasPrice(802, 22),
        title: document.title,
        hint: !!(document.getElementById("genHint") && getComputedStyle(document.getElementById("genHint")).display !== "none"),
        stockTab: !!(document.getElementById("segStock") && getComputedStyle(document.querySelector(".viewbar")).display === "none"),
        pt: getComputedStyle(document.getElementById("ptOpen")).display === "none"
      };
    });
    check("entered general mode", app.mode === "general" && app.title === "一般見積り・請求書");
    check("HW workState unchanged", after.hw === before.hw);
    check("HW printParties unchanged", after.pp === before.pp);
    check("HW price-table key unchanged", after.pt === before.pt);
    check("backup created once with HW keys", !!after.bak && after.bak.includes("hwParts.workState.v1") && after.bak.includes("架空エルボ"));
    check("backup includes dummy price-table key (not inspected)", after.bak.includes("hw_price_table_v1"));
    const bak = JSON.parse(after.bak);
    check("backup stored the exact HW snapshot", bak.keys["hwParts.workState.v1"] === before.hw);
    check("copied names and fictional prices, not qty/stock", app.n801 === "架空エルボ" && app.p11 && app.p22 && app.q801 === 0 && app.s801 == null);
    check("general UI (hint on, stock/price-table hidden)", app.hint && app.stockTab && app.pt);
    check("no page errors", errs.length === 0, errs.join(" | "));
    await ctx.close();
  }

  console.log("# C  edits in general never touch HW; HW edits never touch general");
  {
    const { ctx, page } = await freshPage(true);
    await page.click("#mgGen");
    await wait(400);
    const hwBefore = (await lsDump(page)).hw;
    await page.evaluate(() => {
      const A = window.__HW_APP__;
      A.setName(801, "一般で改名したエルボ");
      A.addTestItem("一般だけにある部材", "テスト");
    });
    await wait(100);
    const mid = await lsDump(page);
    check("after general edits, HW key identical", mid.hw === hwBefore);
    const gen = JSON.parse(mid.gen);
    check("general saved renamed item and new item",
      gen.materials.some((m) => m.id === 801 && m.name === "一般で改名したエルボ") &&
      gen.materials.some((m) => m.name === "一般だけにある部材"));
    const genBefore = mid.gen;

    await page.click("#modeBackBtn");
    await wait(200);
    await page.click("#mgHw");
    await wait(400);
    const inHw = await page.evaluate(() => {
      const A = window.__HW_APP__;
      return {
        mode: A.getMode(),
        n801: A.getName(801),
        q801: A.getQty(801),
        s801: A.getStock(801),
        hasGenOnly: [...Array(A.getMaterialCount())].some((_, i) => false) ||
          (function () {
            // scan via known ids
            return A.getName(801) === "架空エルボ";
          })(),
        namesHaveGen: (function () {
          // 900+ would be general nextId; search by poking storage instead
          return false;
        })()
      };
    });
    const hwState = JSON.parse((await lsDump(page)).hw);
    check("HW mode still has original name, qty 7, stock 3",
      inHw.mode === "hw" && inHw.n801 === "架空エルボ" && inHw.q801 === 7 && inHw.s801 === 3);
    check("general-only item is not in HW storage",
      !hwState.materials.some((m) => m.name === "一般だけにある部材") &&
      hwState.materials.some((m) => m.name === "架空エルボ"));

    await page.evaluate(() => {
      window.__HW_APP__.setName(801, "HWで改名したエルボ");
    });
    await wait(100);
    const afterHwEdit = await lsDump(page);
    const mats = (obj) => JSON.stringify(JSON.parse(obj).materials);
    check("general materials unchanged after HW rename", mats(afterHwEdit.gen) === mats(genBefore));

    await page.click("#modeBackBtn");
    await wait(200);
    await page.click("#mgGen");
    await wait(400);
    const backGen = await page.evaluate(() => ({
      n801: window.__HW_APP__.getName(801),
      hasNew: window.__HW_APP__.getMaterialCount() >= 3
    }));
    check("re-entering general does not recopy (edits kept)", backGen.n801 === "一般で改名したエルボ" && backGen.hasNew);
    const bak1 = (await lsDump(page)).bak;
    // switch again should not rewrite backup
    await page.click("#modeBackBtn");
    await wait(150);
    await page.click("#mgGen");
    await wait(300);
    const bak2 = (await lsDump(page)).bak;
    check("backup is not overwritten on later visits", bak1 === bak2);
    await ctx.close();
  }

  console.log("# D  delete in general, empty list, remember-last-mode");
  {
    const { ctx, page } = await freshPage(true);
    await page.click("#mgGen");
    await wait(400);
    const hwBefore = (await lsDump(page)).hw;
    await page.evaluate(() => {
      const A = window.__HW_APP__;
      A.removeById(801);
      A.removeById(802);
    });
    await wait(100);
    check("HW unchanged after general deletes", (await lsDump(page)).hw === hwBefore);
    let gen = JSON.parse((await lsDump(page)).gen);
    check("general list can be emptied without being reset", Array.isArray(gen.materials) && gen.materials.length === 0 && gen.kind === "general");
    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(300);
    await page.click("#mgGen");
    await wait(400);
    gen = JSON.parse((await lsDump(page)).gen);
    check("reload + re-enter keeps empty general list (no recopy)", gen.materials.length === 0);

    await page.click("#modeBackBtn");
    await wait(200);
    await page.evaluate(() => { document.getElementById("mgRemember").checked = true; });
    await page.click("#mgHw");
    await wait(400);
    const pref = JSON.parse((await lsDump(page)).mode);
    check("remember pref saved for hw", pref && pref.auto === true && pref.last === "hw");
    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(400);
    const auto = await page.evaluate(() => ({
      mode: window.__HW_APP__.getMode(),
      gateHidden: getComputedStyle(document.getElementById("modeGate")).display === "none",
      n801: window.__HW_APP__.getName(801)
    }));
    check("auto-open HW skips start screen and loads HW data", auto.mode === "hw" && auto.gateHidden && auto.n801 === "架空エルボ");
    await page.click("#modeBackBtn");
    await wait(200);
    const gate = await page.evaluate(() => window.__HW_APP__.getMode() === "pick");
    check("mode-back always returns to start screen", gate);
    await ctx.close();
  }

  console.log("# E  no HW state: general inits from builtin; HW key still not written");
  {
    const { ctx, page, errs } = await freshPage(false);
    await page.click("#mgGen");
    await wait(500);
    const info = await page.evaluate(() => {
      const A = window.__HW_APP__;
      return {
        mode: A.getMode(),
        count: A.getMaterialCount(),
        hw: localStorage.getItem("hwParts.workState.v1"),
        gen: !!localStorage.getItem("genParts.workState.v1"),
        bak: !!localStorage.getItem("hwParts.backup.beforeGeneral.v1")
      };
    });
    check("general inits with a non-empty builtin copy", info.mode === "general" && info.count > 50);
    check("entering general without HW data does not create HW workState", info.hw == null);
    check("backup key is created (may have empty keys)", info.bak && info.gen);
    check("no page errors", errs.length === 0, errs.join(" | "));
    // Do not print builtin prices.
    await ctx.close();
  }

  console.log("# F  HW path still has inventory entry and version");
  {
    const { ctx, page, errs } = await freshPage(true);
    await page.click("#mgHw");
    await wait(400);
    const ui = await page.evaluate(() => {
      const stock = document.getElementById("segStock");
      const cs = document.getElementById("countSheetBtn");
      return {
        mode: window.__HW_APP__.getMode(),
        ver: document.getElementById("appVer") && document.getElementById("appVer").textContent,
        stockShown: !!(stock && getComputedStyle(stock).display !== "none"),
        csShown: !!(cs && getComputedStyle(cs).display !== "none"),
        jobs: JSON.parse(localStorage.getItem("hwParts.workState.v1") || "{}").jobs
      };
    });
    check("HW shows stock tab and count-sheet button", ui.mode === "hw" && ui.stockShown && ui.csShown);
    check("version label is v2.0", ui.ver && ui.ver.indexOf("v2.0") !== -1);
    check("HW jobs fixture preserved", Array.isArray(ui.jobs) && ui.jobs[0] && ui.jobs[0].site === "架空現場A");
    check("no page errors", errs.length === 0, errs.join(" | "));
    await ctx.close();
  }

  await browser.close();
  console.log("");
  if (failures.length) {
    console.log("FAILED", failures.length);
    failures.forEach((f) => console.log(" - " + f));
    process.exit(1);
  }
  console.log("ALL PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
