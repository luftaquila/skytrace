import { expect, test } from "@playwright/test";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RASTER_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function ingestAircraft(request, overrides = {}) {
  const now = Date.now() / 1000;
  const response = await request.post("/api/ingest/readsb", {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: {
      receiver: {
        id: "rx-1",
        name: "Roof Receiver",
        lat: 37.5,
        lon: 127.1,
      },
      payload: {
        now,
        aircraft: [{
          hex: "abc123",
          type: "adsb_icao",
          flight: "SKY42",
          lat: 37.55,
          lon: 127.05,
          alt_baro: 32000,
          alt_geom: 33100,
          gs: 430,
          ias: 280,
          tas: 460,
          mach: 0.76,
          track: 90,
          true_heading: 91,
          baro_rate: 640,
          squawk: "1200",
          seen: 0,
          seen_pos: 0,
          messages: 50,
          ...overrides,
        }],
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function openApp(page, request) {
  await ingestAircraft(request);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem("skytrace.settings") || "{}");
    localStorage.setItem(
      "skytrace.settings",
      JSON.stringify({ ...settings, mapReferenceLabels: false }),
    );
  });
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1:4173\/).*/,
    (route) => route.fulfill({ contentType: "image/png", body: RASTER_TILE_PNG }),
  );
  await page.goto("/");
  await expect(page.getByText("SKYTRACE", { exact: true })).toBeVisible();
  await expect(page.locator(".target-row")).toContainText("SKY42");
  return pageErrors;
}

async function expandCard(card) {
  const header = card.locator("header");
  if (await header.getAttribute("aria-expanded") !== "true") await header.click();
}

test("desktop traffic selection drives the target console and Escape lifecycle", async ({ page, request }) => {
  const pageErrors = await openApp(page, request);
  const targetToggle = page.locator(".cbar-stations").getByRole("button", { name: "Target" });

  await expect(page.locator(".station-traffic")).toBeVisible();
  await expect(targetToggle).toBeDisabled();
  await page.locator(".target-row").click();

  await expect(targetToggle).toBeEnabled();
  await expect(page.locator(".station-target")).toBeVisible();
  await expect(page.locator(".station-target")).toContainText("SKY42");
  await expect(page.locator(".station-target")).toContainText("32,000 ft");
  await expect(page.locator(".station-target")).toContainText("430 kts");

  await targetToggle.click();
  await expect(page.locator(".station-target")).toHaveCount(0);
  await targetToggle.click();
  await expect(page.locator(".station-target")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".station-target")).toHaveCount(0);
  await expect(targetToggle).toBeDisabled();

  await page.locator(".station-traffic").getByRole("button", { name: "Close the traffic console" }).click();
  await expect(page.locator(".station-traffic")).toBeHidden();
  await page.reload();
  await expect(page.locator(".cbar-stations")).toBeVisible();
  await expect(page.locator(".station-traffic")).toBeHidden();
  await page.locator(".cbar-stations").getByRole("button", { name: "Traffic" }).click();
  await expect(page.locator(".station-traffic")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("unit controls convert filter values and persist the result across reload", async ({ page, request }) => {
  const pageErrors = await openApp(page, request);
  await page.locator(".cbar-stations").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".station-systems")).toBeVisible();

  const filters = page.locator(".cblock").filter({ hasText: "Filters" });
  const units = page.locator(".cblock").filter({ hasText: "Units" });
  await expandCard(filters);
  await expandCard(units);
  await filters.getByText("Min altitude").locator("..").getByRole("textbox").fill("10000");
  await units.getByRole("button", { name: "Metric" }).click();

  await expect(filters.getByText("Min altitude").locator("..").getByRole("textbox")).toHaveValue("3048");
  await expect(filters.getByText("Min altitude").locator("..")).toContainText("m");
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("skytrace.settings"));
    return [stored.unitAltitude, stored.altMin];
  })).toEqual(["m", "3048"]);

  await page.reload();
  await page.locator(".cbar-stations").getByRole("button", { name: "Settings" }).click();
  const reloadedFilters = page.locator(".cblock").filter({ hasText: "Filters" });
  await expandCard(reloadedFilters);
  await expect(reloadedFilters.getByText("Min altitude").locator("..").getByRole("textbox")).toHaveValue("3048");

  await page.locator(".map-3d").click({ position: { x: 20, y: 120 } });
  await expect(page.locator(".station-systems")).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("phone tabs expose one thumb-sized console at a time", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors = await openApp(page, request);
  const tabs = page.locator(".station-tabs");

  await expect(page.locator(".cbar-stations")).toBeHidden();
  await expect(tabs).toBeVisible();
  await tabs.getByRole("button", { name: "Traffic" }).click();
  await expect(page.locator(".station-traffic")).toBeVisible();
  await page.locator(".target-row").click();
  await expect(tabs.getByRole("button", { name: "Target" })).toBeEnabled();
  await tabs.getByRole("button", { name: "Target" }).click();
  await expect(page.locator(".station-target")).toBeVisible();
  await expect(page.locator(".station-traffic")).toBeHidden();

  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".station-systems")).toBeVisible();
  await expect(page.locator(".station-target")).toHaveCount(0);

  const boxes = await tabs.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(pageErrors).toEqual([]);
});

test("map attribution opens shipped provider and package licence data", async ({ page, request }) => {
  const pageErrors = await openApp(page, request);
  await page.getByRole("button", { name: "Map data and licences" }).click();
  const dialog = page.getByRole("dialog", { name: "Map data and licences" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Imagery");
  await expect(dialog.locator("a")).not.toHaveCount(0);

  await dialog.getByRole("button", { name: /Open source licenses/ }).click();
  await expect(dialog.locator(".credits-pkg").first()).toBeVisible();
  await expect(dialog.locator(".credits-pkg")).not.toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("configuration import rejects noise, applies valid settings, and exports a file", async ({ page, request }) => {
  const pageErrors = await openApp(page, request);
  await page.locator(".cbar-stations").getByRole("button", { name: "Settings" }).click();
  const configuration = page.locator(".cblock").filter({ hasText: "Configuration" });
  await expandCard(configuration);
  const fileInput = configuration.locator('input[type="file"]');

  await fileInput.setInputFiles({
    name: "not-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ unrelated: true })),
  });
  await expect(page.getByRole("alert")).toContainText("Import failed");

  await fileInput.setInputFiles({
    name: "skytrace-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      app: "skytrace",
      settings: "skytrace.settings",
      values: { unitAltitude: "m", altMin: "3048", ringCount: 7 },
    })),
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("skytrace.settings"));
    return [stored.unitAltitude, stored.altMin, stored.ringCount];
  })).toEqual(["m", "3048", 7]);

  const downloadPromise = page.waitForEvent("download");
  await configuration.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("skytrace-settings.json");
  expect(pageErrors).toEqual([]);
});
