// Provider credits for every live map source.
//
// One definition per source feeds BOTH the `attribution` string MapLibre carries in the style and
// the ⓘ popover that actually renders them. Keeping them in one place is what stops a credit from
// drifting between the style and the UI — the failure mode that left "Maxar" on screen for a year
// after Esri's imagery supplier had been rebranded to Vantor.
//
// MapLibre's own AttributionControl is deliberately NOT used: it renders a single collapsed line,
// which cannot host the open-source licence list the same popover has to carry.

/** @typedef {{ role: string, html: string }} Credit */

function link(href, text) {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

// Esri World Imagery. The wording tracks the live service's own `copyrightText`, which is the only
// authoritative source for who currently supplies the imagery.
/** @type {Credit} */
export const SATELLITE_CREDIT = {
  role: "Imagery",
  html: `Source: ${link("https://www.esri.com/", "Esri")}, Vantor, Earthstar Geographics, and the GIS User Community`,
};

// Mapterhorn composites 134 open-data elevation sources; 51 of them are CC BY variants that require
// naming the producer. CC BY 4.0 §3(a)(2) lets a hyperlink to a resource carrying the required
// information stand in for the full list, which is exactly what Mapterhorn's own TileJSON does — so
// the link is the credit, not a shortcut around it.
/** @type {Credit} */
export const TERRAIN_CREDIT = {
  role: "Terrain",
  html: `© ${link("https://mapterhorn.com/attribution", "Mapterhorn")}`,
};

// OpenFreeMap asks for "OpenFreeMap © OpenMapTiles Data from OpenStreetMap". The OpenFreeMap part is
// optional by their own wording; OpenMapTiles and OpenStreetMap are not. The OpenStreetMap link
// points at /copyright, which is how the OSMF attribution guidelines allow the ODbL notice itself to
// be satisfied by reference.
/** @type {Credit} */
export const REFERENCE_CREDIT = {
  role: "Labels",
  html: [
    link("https://openfreemap.org/", "OpenFreeMap"),
    `© ${link("https://openmaptiles.org/", "OpenMapTiles")}`,
    `Data from ${link("https://www.openstreetmap.org/copyright", "OpenStreetMap")}`,
  ].join(" · "),
};

// OurAirports releases its data to the public domain and asks for credit without requiring it
// ("We'd love you to give us credit, like we give credit to our sources, but you're not required
// to."). Listed anyway: this is the only credit here that is a courtesy rather than a condition.
/** @type {Credit} */
export const AIRFIELDS_CREDIT = {
  role: "Airfields",
  html: `Data from ${link("https://ourairports.com/data/", "OurAirports")}, public domain`,
};

// Area traffic comes from whichever community aggregator the OPERATOR configured, so the provider
// cannot be written down here — a deployment pointed at adsb.fi or airplanes.live would then be
// crediting a database it never touched. The server reports the upstream host it is actually using
// (features.areaFeedHost) and that name is what gets credited.
//
// ODbL — which adsb.lol publishes under — requires identifying the source database rather than
// describing it, so a host is the minimum honest credit. Nothing is stored (server/area-feed.mjs
// touches no table), so only that notice applies, not the licence's share-alike terms, which reach
// derivative databases rather than a display.
//
// @param {string|null} host
// @returns {Credit}
export function areaTrafficCredit(host) {
  const clean = typeof host === "string" ? host.trim() : "";
  // Guard the interpolation: this host reaches the DOM through v-html.
  const safe = /^[a-z0-9.-]+(?::\d+)?$/i.test(clean) ? clean : "";
  return {
    role: "Traffic",
    html: safe
      ? `Area traffic from ${link(`https://${safe}/`, safe)}`
      : "Area traffic from the operator's configured aggregator",
  };
}

/**
 * Every source this build can draw from. The list is NOT filtered against the layer toggles:
 * crediting a source that is switched off is not a licence problem, failing to credit one that is
 * switched on is, and a fixed list cannot drift out of step with the settings. Only the aggregator
 * varies, because only its identity is decided outside this code.
 *
 * @param {{ areaFeedHost?: string|null }} [options]
 * @returns {Credit[]}
 */
export function mapCredits({ areaFeedHost = null } = {}) {
  return [
    SATELLITE_CREDIT,
    TERRAIN_CREDIT,
    REFERENCE_CREDIT,
    AIRFIELDS_CREDIT,
    areaTrafficCredit(areaFeedHost),
  ];
}
