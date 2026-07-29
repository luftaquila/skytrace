import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

// MapLibre GL JS v6 is ESM-only. Vite must bundle the module worker through its worker pipeline;
// a plain `?url` works in development but leaves the production worker's shared import unresolved.
maplibregl.setWorkerUrl(workerUrl);

export default maplibregl;
