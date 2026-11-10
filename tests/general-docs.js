#!/usr/bin/env node
// Step 2: settings, tax, documents. Fictional data only. Never log real prices from the builtin list.
"use strict";
const puppeteer = require("puppeteer-core");
const path = require("path");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const FILE = process.env.U || ("file://" + path.resolve(__dirname, "../hw-parts-calculator.html"));

const HW_FIXTURE = {
  v: 3, priceRev: "2026-10-25", savedAt: "2026-11-01T00:00:00.000Z",
  taxRate: 10, nextId: 900, catMig: 1,
  materials: [
    { id: 801, cat: "テスト", name: "架空エルボ", size: "20A", mode: "piece", price: 11, packLen: 0, qty: 7, stock: 3, cnu: "個" },
    { id: 802, cat: "テスト", name: "架空パイプ", size: "1m", mode: "length", price: 22, packLen: 10, qty: 1.5, cnu: "m" }
  ],
  jobs: [{ id: "job-fic", site: "架空現場A", date: "2026-11-01", items: [], total: 0 }],
  history: []
};

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log("  OK  " + name);
  else { failures.push(name + (detail ? " :: " + detail : "")); console.log("  NG  " + name + (detail ? " :: " + detail : "")); }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"], headless: "new" });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fresh() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(FILE);
    await wait(200);
    await page.evaluate((hw) => {
      localStorage.setItem("hwParts.workState.v1", JSON.stringify(hw));
    }, HW_FIXTURE);
    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(300);
    await page.click("#mgGen");
    await wait(400);
    return { ctx, page, errs };
  }
  function hwSnap(page) {
    return page.evaluate(() => ({
      hw: localStorage.getItem("hwParts.workState.v1"),
      pp: localStorage.getItem("hwParts.printParties.v1"),
      pt: localStorage.getItem("hw_price_table_v1")
    }));
  }

  console.log("# 1  tax rounding & invoice number");
  {
    const { ctx, page, errs } = await fresh();
    const r = await page.evaluate(() => {
      const A = window.__HW_APP__;
      const v1 = A.validateInvoiceReg("");
      const v2 = A.validateInvoiceReg("t1234567890123");
      const v3 = A.validateInvoiceReg("1234567890123");
      const v4 = A.validateInvoiceReg("T123");
      const v5 = A.normalizeInvoiceReg("1234567890123");
      const floor = A.yenRound(99.9, "floor");
      const rnd = A.yenRound(99.5, "round");
      const ceil = A.yenRound(99.1, "ceil");
      const doc = { round: "floor", lines: [
        { qty: 1, price: 999, taxRate: 10 },
        { qty: 1.5, price: 11, taxRate: 10 },
        { qty: 1, price: 100, taxRate: 8 }
      ]};
      const t = A.docTotals(doc);
      const tR = A.docTotals({ ...doc, round: "round" });
      const tC = A.docTotals({ ...doc, round: "ceil" });
      // 999*10%=99.9, 16.5*10%=1.65 → floor group 10% excl=1015.5 tax=floor(101.55)=101
      // 100*8%=8
      return { v1, v2, v3, v4, v5, floor, rnd, ceil, t, tR, tC, hooks: !!(A.GEN_SET_KEY && A.GEN_DOCS_KEY) };
    });
    check("empty reg ok", r.v1.ok && r.v1.value === "");
    check("T+13 and 13 digits normalize", r.v2.ok && r.v2.value === "T1234567890123" && r.v3.ok && r.v5 === "T1234567890123");
    check("short number rejected", !r.v4.ok);
    check("yenRound floor/round/ceil", r.floor === 99 && r.rnd === 100 && r.ceil === 100);
    check("10% group floor tax", r.t.rows.some((x) => x.rate === 10 && x.excl === 1015.5 && x.tax === 101));
    check("8% group tax 8", r.t.rows.some((x) => x.rate === 8 && x.excl === 100 && x.tax === 8));
    check("incl is excl+tax", r.t.incl === r.t.excl + r.t.tax);
    check("round vs floor differ on 10% group", r.tR.rows.find((x) => x.rate === 10).tax === 102);
    check("hooks present", r.hooks);
    check("no page errors", errs.length === 0, errs.join(" | "));
    await ctx.close();
  }

  console.log("# 2  settings persist, do not touch HW keys");
  {
    const { ctx, page } = await fresh();
    const before = await hwSnap(page);
    await page.click("#genSetBtn");
    await wait(300);
    const vis = await page.evaluate(() => getComputedStyle(document.getElementById("genSet")).display !== "none");
    check("settings screen opens", vis);
    await page.evaluate(() => {
      const A = window.__HW_APP__;
      A.setSettings({
        invoiceReg: "T1234567890123",
        round: "floor",
        company: { name: "架空工業株式会社", person: "架空 太郎", postal: "000-0000", address: "架空県架空市1-1", tel: "000-0000-0000", bank: "架空銀行 架空支店 普通 0000000" }
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(300);
    await page.click("#mgGen");
    await wait(400);
    const after = await page.evaluate(() => window.__HW_APP__.getSettings());
    const snap = await hwSnap(page);
    check("settings restored", after.companyName === "架空工業株式会社" && after.invoiceReg === "T1234567890123" && after.round === "floor");
    check("HW keys unchanged after settings", snap.hw === before.hw);
    await ctx.close();
  }

  console.log("# 3  documents: create, convert, no number, master add, cost hidden, HW intact");
  {
    const { ctx, page, errs } = await fresh();
    const before = await hwSnap(page);
    const r = await page.evaluate(() => {
      const A = window.__HW_APP__;
      A.setSettings({ invoiceReg: "T1234567890123", company: { name: "架空工業株式会社" } });
      const est = A.blankDoc("estimate");
      est.title = "架空現場の工事";
      est.client = { name: "架空商店", honorific: "御中", contact: "架空花子", address: "架空町2-2" };
      est.lines = [
        { id: "l1", type: "material", mid: 801, name: "架空エルボ", size: "20A", unit: "個", qty: 1.5, price: 11, taxRate: 10 },
        { id: "l2", type: "labor", mid: null, name: "工事費", size: "", unit: "式", qty: 1, price: 100, taxRate: 10 },
        { id: "l3", type: "discount", mid: null, name: "値引き", size: "", unit: "式", qty: 1, price: -10, taxRate: 10 },
        { id: "l4", type: "material", mid: null, name: "新しい架空部材", size: "", unit: "個", qty: 2, price: 5, taxRate: 10 }
      ];
      A.setCurrent(est);
      A.upsertMasterFromLine(est.lines[3]);
      A.persistCurrentDoc();
      const inv = A.invoiceFromEstimate(est);
      inv.title = est.title;
      A.setCurrent(inv);
      A.persistCurrentDoc();
      const docs = A.getDocs();
      const names = [];
      // scan general master names only
      const nNew = A.getName(est.lines[3].mid);
      const hwStill = JSON.parse(localStorage.getItem("hwParts.workState.v1"));
      const printed = (function () {
        A.openPrint(inv);
        return document.getElementById("dpPage").innerText;
      })();
      const printHtml = document.getElementById("dpPage").innerHTML;
      // cost field: set on a general material and ensure not in print
      const m = (function(){ /* peek via setName only */ return true; })();
      return {
        docs, nNew,
        hasNewInHw: hwStill.materials.some((x) => x.name === "新しい架空部材"),
        hwName: hwStill.materials.find((x) => x.id === 801).name,
        printed, printHtml,
        invKind: inv.kind, invFrom: inv.fromId, invId: inv.id, estId: est.id,
        hasNumField: !!(inv.number || inv.no || inv.docNo),
        hasValid: !!inv.validUntil, hasDue: !!inv.dueDate,
        lineCount: inv.lines.length,
        qty15: inv.lines[0].qty
      };
    });
    const after = await hwSnap(page);
    check("estimate and invoice saved", r.docs.length === 2 && r.docs.some((d) => d.kind === "estimate") && r.docs.some((d) => d.kind === "invoice"));
    check("invoice copied from estimate, new id", r.invKind === "invoice" && r.invFrom === r.estId && r.invId !== r.estId && r.lineCount === 4);
    check("no document number field", !r.hasNumField && r.docs.every((d) => !d.hasNumber));
    check("qty 1.5 preserved", r.qty15 === 1.5);
    check("invoice has due date, not validUntil", r.hasDue && !r.hasValid);
    check("typed new material added to general master", r.nNew === "新しい架空部材");
    check("new material not in HW storage", !r.hasNewInHw && r.hwName === "架空エルボ");
    check("HW workState byte-identical", after.hw === before.hw);
    check("print shows 見積/請求 and 登録番号, not 原価 or 書類番号",
      r.printed.includes("請求書") && r.printed.includes("登録番号") && r.printed.includes("T1234567890123") &&
      r.printed.includes("架空商店") && r.printed.includes("工事費") && r.printed.includes("値引き") &&
      !r.printed.includes("原価") && !r.printed.includes("書類番号") && !r.printHtml.includes("cost"));
    check("印 space present", r.printHtml.includes("印"));
    check("no page errors", errs.length === 0, errs.join(" | "));
    await ctx.close();
  }

  console.log("# 4  UI editor + HW isolation after opening editor");
  {
    const { ctx, page, errs } = await fresh();
    const before = await hwSnap(page);
    await page.click("#genEstBtn");
    await wait(400);
    const ui = await page.evaluate(() => {
      const ed = document.getElementById("docEd");
      return {
        open: ed.classList.contains("open"),
        title: (ed.innerText || "").includes("見積書"),
        noNumber: !/(書類番号|伝票番号|No\.)\s*[:：]/.test(ed.innerText) && !ed.querySelector("#deNumber, #deDocNo")
      };
    });
    check("estimate editor opens, no number field", ui.open && ui.title && ui.noNumber);
    await page.click("#deClose");
    await wait(200);
    await page.click("#modeBackBtn");
    await wait(200);
    await page.click("#mgHw");
    await wait(400);
    const hw = await page.evaluate(() => ({
      mode: window.__HW_APP__.getMode(),
      name: window.__HW_APP__.getName(801),
      qty: window.__HW_APP__.getQty(801),
      cs: getComputedStyle(document.getElementById("countSheetBtn")).display !== "none"
    }));
    const after = await hwSnap(page);
    check("HW mode intact after general editor", hw.mode === "hw" && hw.name === "架空エルボ" && hw.qty === 7 && hw.cs);
    check("HW key unchanged after editor session", after.hw === before.hw);
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
})().catch((e) => { console.error(e); process.exit(1); });
