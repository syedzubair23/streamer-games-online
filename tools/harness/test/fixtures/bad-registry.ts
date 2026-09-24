/** Malformed scenario registries for the manifest loader's error paths. */
export const noBuild = { x: { id: "x", description: "no build" } };
export const wrongId = {
  x: { id: "y", description: "key and id differ", build: () => ({ state: null }) },
};
