// Skytrace drives an elevated globe camera at display refresh rate and keeps MapLibre's source
// selection on a separate 60 Hz cadence. MapLibre v6 moved the same camera objects behind a
// composed Camera instance. Keep that exact-version compatibility boundary in one small module
// instead of spreading the new private object graph through the tactical renderer.

export function mapTransform(map) {
  const transform = map?._camera?.transform;
  if (!transform) throw new Error("MapLibre camera transform is unavailable");
  return transform;
}

export function requestedCameraTransform(map) {
  return map?._camera?._requestedCameraState || null;
}

export function mapCameraHelper(map) {
  const helper = map?._camera?.cameraHelper;
  if (!helper) throw new Error("MapLibre camera helper is unavailable");
  return helper;
}

export function mapHandlerRegistry(map) {
  return map?._handlers?._handlersById || null;
}
