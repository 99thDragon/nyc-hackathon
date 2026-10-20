// RevenueCat-shaped billing, with the network calls stubbed.
//
// WHY THIS SHAPE: every object below mirrors what @revenuecat/purchases-js
// actually returns -- Offering -> availablePackages[] -> rcBillingProduct ->
// currentPrice.formattedPrice, and CustomerInfo.entitlements.active. The UI
// reads only those fields. Swapping the stub for the real SDK is therefore
// one function (see SWAP POINT at the bottom), not a rewrite of the paywall.
//
// What is NOT real yet: the checkout. Purchases are granted locally. Say so
// on stage -- the PRD's §10 fallback is explicit that a stubbed checkout is
// fine if you name it, and a quiet fake is worse than an honest stub.
"use strict";

(() => {
  const ENTITLEMENT = "pro";
  const STORE_KEY = "mc:entitlements";

  // ---------------------------------------------------------------- offering
  // Prices and the free/Pro split come from PRD §6: everything that is a free
  // read of public data stays free; everything we pay to accumulate is Pro.
  const OFFERING = {
    identifier: "default",
    serverDescription: "Magic Carpet Pro",
    metadata: {},
    availablePackages: [
      {
        identifier: "$rc_monthly",
        packageType: "MONTHLY",
        rcBillingProduct: {
          identifier: "mc_pro_monthly",
          title: "Magic Carpet Pro",
          description: "Monthly",
          currentPrice: { amountMicros: 4_990_000, currency: "USD", formattedPrice: "$4.99" },
          normalPeriodDuration: "P1M",
        },
      },
      {
        identifier: "$rc_annual",
        packageType: "ANNUAL",
        rcBillingProduct: {
          identifier: "mc_pro_annual",
          title: "Magic Carpet Pro",
          description: "Annual",
          currentPrice: { amountMicros: 39_000_000, currency: "USD", formattedPrice: "$39.00" },
          normalPeriodDuration: "P1Y",
        },
      },
    ],
  };

  const FEATURES = [
    ["Live step-free verdict, any station", true, true],
    ["Nearest step-free alternative", true, true],
    ["Evidence and sources on tap", true, true],
    ["Elevator reliability history", false, true],
    ["Saved routes", false, true],
    ["Alerts before an elevator goes down", false, true],
    ["Offline station pack", false, true],
  ];

  // ------------------------------------------------------------ customerInfo
  function emptyCustomerInfo() {
    return {
      originalAppUserId: anonId(),
      entitlements: { active: {}, all: {} },
      activeSubscriptions: [],
      requestDate: new Date().toISOString(),
    };
  }

  function customerInfoFor(productIdentifier, expiresAt) {
    const ent = {
      identifier: ENTITLEMENT,
      isActive: true,
      willRenew: true,
      periodType: "NORMAL",
      productIdentifier,
      latestPurchaseDate: new Date().toISOString(),
      expirationDate: expiresAt,
      store: "rc_billing",
    };
    return {
      originalAppUserId: anonId(),
      entitlements: { active: { [ENTITLEMENT]: ent }, all: { [ENTITLEMENT]: ent } },
      activeSubscriptions: [productIdentifier],
      requestDate: new Date().toISOString(),
    };
  }

  function anonId() {
    try {
      let id = localStorage.getItem("mc:appUserId");
      if (!id) {
        id = "$RCAnonymousID:" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("mc:appUserId", id);
      }
      return id;
    } catch {
      return "$RCAnonymousID:ephemeral";
    }
  }

  // Browser storage can throw in private mode, and an entitlement we cannot
  // read is simply not active -- never a crash, never an accidental unlock.
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyCustomerInfo();
      const info = JSON.parse(raw);
      const ent = info?.entitlements?.active?.[ENTITLEMENT];
      if (ent && ent.expirationDate && Date.parse(ent.expirationDate) < Date.now()) {
        return emptyCustomerInfo(); // lapsed
      }
      return info?.entitlements ? info : emptyCustomerInfo();
    } catch {
      return emptyCustomerInfo();
    }
  }

  function save(info) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(info)); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------- the backend
  // SWAP POINT lives here. Both implementations return identical shapes.
  function stubBackend() {
    let info = load();
    return {
      stubbed: true,
      async getOfferings() { return { current: OFFERING, all: { default: OFFERING } }; },
      async getCustomerInfo() { return info; },
      async purchase({ rcPackage }) {
        const product = rcPackage.rcBillingProduct;
        const months = rcPackage.packageType === "ANNUAL" ? 12 : 1;
        const expires = new Date();
        expires.setMonth(expires.getMonth() + months);
        info = customerInfoFor(product.identifier, expires.toISOString());
        save(info);
        return { customerInfo: info, redemptionInfo: null };
      },
      async restore() { info = load(); return info; },
      async signOut() { info = emptyCustomerInfo(); save(info); return info; },
    };
  }

  const backend = stubBackend();

  // ------------------------------------------------------------------ public
  const listeners = new Set();
  function notify(info) { for (const fn of listeners) { try { fn(info); } catch { /* ignore */ } } }

  const Billing = {
    ENTITLEMENT,
    stubbed: backend.stubbed,
    features: FEATURES,
    async getOfferings() { return backend.getOfferings(); },
    async getCustomerInfo() { return backend.getCustomerInfo(); },
    async isPro() {
      const info = await backend.getCustomerInfo();
      return Boolean(info?.entitlements?.active?.[ENTITLEMENT]?.isActive);
    },
    async purchase(rcPackage) {
      const result = await backend.purchase({ rcPackage });
      notify(result.customerInfo);
      return result;
    },
    async restore() { const i = await backend.restore(); notify(i); return i; },
    async signOut() { const i = await backend.signOut(); notify(i); return i; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  globalThis.MagicCarpetBilling = Billing;

  // ------------------------------------------------------------- paywall UI
  // Built from the offering, not hardcoded, so the real SDK's prices and
  // packages render without touching this code.
  let dialog = null;

  function buildDialog(offering, isPro) {
    const d = document.createElement("dialog");
    d.id = "paywall";
    d.setAttribute("aria-labelledby", "pw-title");

    const rows = FEATURES.map(([label, free, pro]) => `
      <tr>
        <th scope="row">${esc(label)}</th>
        <td>${free ? '<span class="tick" aria-label="included">✓</span>' : '<span class="dash" aria-label="not included">—</span>'}</td>
        <td>${pro ? '<span class="tick" aria-label="included">✓</span>' : '<span class="dash" aria-label="not included">—</span>'}</td>
      </tr>`).join("");

    const packages = offering.availablePackages.map((p) => {
      const price = p.rcBillingProduct.currentPrice.formattedPrice;
      const per = p.packageType === "ANNUAL" ? "per year" : "per month";
      const note = p.packageType === "ANNUAL" ? "Save 35%" : "";
      return `<button type="button" class="buy" data-package="${esc(p.identifier)}">
          <span class="buy-price">${esc(price)}</span>
          <span class="buy-per">${esc(per)}</span>
          ${note ? `<span class="buy-note">${esc(note)}</span>` : ""}
        </button>`;
    }).join("");

    d.innerHTML = `
      <form method="dialog" class="pw-close-form">
        <button class="pw-close" aria-label="Close">✕</button>
      </form>
      <h2 id="pw-title">Magic Carpet <b>PRO</b></h2>
      <p class="pw-sub">The free tier is a public service built on public data.
        Pro is the record we build ourselves — and the alerts only we can send.</p>

      <table class="pw-table">
        <thead><tr><td></td><th scope="col">Free</th><th scope="col">Pro</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="pw-buys" ${isPro ? "hidden" : ""}>${packages}</div>
      <p class="pw-active" ${isPro ? "" : "hidden"}>You're on Pro. Alerts are on.</p>

      <p class="pw-stub">${backend.stubbed
        ? "Billing is stubbed for this build — no card is charged and nothing is sent to RevenueCat. The offering, package and entitlement shapes are RevenueCat's, so wiring the real SDK is one function."
        : "Payments handled by RevenueCat Web Billing."}</p>
      <button type="button" class="pw-restore">Restore purchases</button>`;

    d.addEventListener("click", async (e) => {
      const buy = e.target.closest(".buy");
      if (buy) {
        const pkg = offering.availablePackages.find((p) => p.identifier === buy.dataset.package);
        if (!pkg) return;
        buy.disabled = true;
        buy.textContent = "…";
        await Billing.purchase(pkg);
        d.close();
        return;
      }
      if (e.target.closest(".pw-restore")) { await Billing.restore(); d.close(); }
      // Click on the backdrop closes it.
      if (e.target === d) d.close();
    });
    return d;
  }

  async function openPaywall() {
    const [{ current }, isPro] = await Promise.all([Billing.getOfferings(), Billing.isPro()]);
    if (dialog) dialog.remove();
    dialog = buildDialog(current, isPro);
    document.body.append(dialog);
    dialog.showModal();
  }
  Billing.openPaywall = openPaywall;

  // --------------------------------------------------------- the Pro button
  // The team already placed a disabled `.pro` button in index.html. Wiring it
  // here means app.js needs no changes at all.
  function wireProButton() {
    const btn = document.querySelector("button.pro");
    if (!btn) return;
    btn.disabled = false;
    btn.style.cursor = "pointer";

    const paint = async () => {
      const pro = await Billing.isPro();
      const label = btn.querySelector("span");
      const badge = btn.querySelector("b");
      const station = (document.getElementById("v-name")?.textContent || "").trim();
      if (pro) {
        label.textContent = station ? `🔔 Alerts on for ${station}` : "🔔 Alerts on";
        badge.textContent = "PRO";
        btn.classList.add("is-pro");
      } else {
        label.textContent = "🔔 Alert me when this changes";
        badge.textContent = "PRO";
        btn.classList.remove("is-pro");
      }
    };

    btn.addEventListener("click", async () => {
      if (await Billing.isPro()) { openPaywall(); return; } // manage
      openPaywall();
    });
    Billing.onChange(paint);

    // The station name changes as the rider taps around; keep the label honest.
    const name = document.getElementById("v-name");
    if (name) new MutationObserver(paint).observe(name, { childList: true, characterData: true, subtree: true });
    paint();
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireProButton);
  } else {
    wireProButton();
  }

  // ===========================================================================
  // SWAP POINT — replacing the stub with real RevenueCat Web Billing
  // ===========================================================================
  //
  //   npm i @revenuecat/purchases-js
  //
  //   import { Purchases } from "@revenuecat/purchases-js";
  //
  //   function realBackend(apiKey) {
  //     const p = Purchases.configure({ apiKey, appUserId: anonId() });
  //     return {
  //       stubbed: false,
  //       getOfferings:    () => p.getOfferings(),
  //       getCustomerInfo: () => p.getCustomerInfo(),
  //       purchase: ({ rcPackage }) => p.purchase({ rcPackage }),
  //       restore:  () => p.getCustomerInfo(),
  //       signOut:  () => p.changeUser(anonId()),
  //     };
  //   }
  //
  //   const backend = realBackend(WEB_BILLING_PUBLIC_KEY);
  //
  // Nothing above this block changes. The UI already reads
  // offering.availablePackages[].rcBillingProduct.currentPrice.formattedPrice
  // and customerInfo.entitlements.active.pro, which is what the SDK returns.
  //
  // The Web Billing *public* key is designed to ship in client JS — it is in
  // the bundle on every RevenueCat web integration. Keep secret keys out of
  // the repo; this one does not need hiding.
})();
