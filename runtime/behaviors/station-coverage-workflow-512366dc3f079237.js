export default async function install(app) {
  const mount = app.getMount("coverage-workflow");
  const [serviceArea, networkService, ServiceAreaParameters, FeatureSet, Graphic, Portal] = await Promise.all([
    app.import("esri/rest/serviceArea"), app.import("esri/rest/networkService"), app.import("esri/rest/support/ServiceAreaParameters"), app.import("esri/rest/support/FeatureSet"), app.import("esri/Graphic"), app.import("esri/portal/Portal")
  ]);
  const stationLayer = app.layers[app.config.stationLayerId];
  app.assert(stationLayer, "The NYPD police-stations layer is not available.");
  await stationLayer.load();
  const oidField = stationLayer.objectIdField;
  const fields = [oidField, "POLICE_PREC", "FACILITY_ADDRESS"];
  const areas = await app.createResultLayer({
    id: "ten-minute-response-area", title: "10-minute Driving Service Area", geometryType: "polygon",
    fields: [{ name: "precinct", type: "string" }, { name: "minutes", type: "double" }],
    renderer: { type: "simple", symbol: { type: "simple-fill", color: [209, 73, 91, 0.22], outline: { color: [163, 36, 57, 0.95], width: 2 } } },
    popupTemplate: { title: "{minutes}-minute driving area", content: "NYPD Precinct {precinct}" }
  });
  const root = document.createElement("div"); root.style.display = "grid"; root.style.gap = "var(--app-gap)"; root.style.minWidth = "0";
  const instructions = document.createElement("p"); instructions.style.margin = "0"; instructions.style.color = "var(--app-text-muted)"; instructions.textContent = "Click a station on the map, or search by precinct number or address.";
  const input = document.createElement("calcite-input-text"); input.setAttribute("placeholder", "e.g. 19 or 153 E 67th St"); input.setAttribute("label", "Search NYPD stations"); input.setAttribute("clearable", "");
  const button = document.createElement("calcite-button"); button.setAttribute("appearance", "outline"); button.setAttribute("width", "full"); button.textContent = "Find station";
  const status = document.createElement("calcite-notice"); status.open = true; status.setAttribute("kind", "info");
  const statusMessage = document.createElement("div"); statusMessage.slot = "message"; status.append(statusMessage);
  const results = document.createElement("calcite-list"); results.setAttribute("label", "Station search results"); results.setAttribute("selection-mode", "none");
  root.append(instructions, input, button, status, results); mount.replaceChildren(root);
  let requestNumber = 0; let serviceAreaConfig;
  const setStatus = (text, kind = "info") => { status.setAttribute("kind", kind); statusMessage.textContent = text; };
  setStatus("Choose a station to create a 10-minute driving service area.");
  const getServiceAreaConfig = async () => {
    if (serviceAreaConfig) return serviceAreaConfig;
    const portal = new Portal(app.portalUrl ? { url: app.portalUrl } : {}); await portal.load();
    const serviceAreaUrl = portal.helperServices?.serviceArea?.url; app.assert(serviceAreaUrl, "This portal does not advertise a service-area helper service.");
    const { supportedTravelModes } = await networkService.fetchServiceDescription(serviceAreaUrl);
    const mode = (supportedTravelModes || []).find((candidate) => candidate.type === "automobile" && candidate.impedanceAttributeName === candidate.timeAttributeName);
    app.assert(mode, "The service-area helper has no time-based driving mode."); serviceAreaConfig = { serviceAreaUrl, mode }; return serviceAreaConfig;
  };
  const solveForGraphic = async (graphic) => {
    const current = ++requestNumber; const precinct = String(graphic.attributes?.POLICE_PREC ?? "Unknown"); const address = String(graphic.attributes?.FACILITY_ADDRESS ?? "Selected station");
    setStatus(`Creating a ${app.config.minutes}-minute driving area for Precinct ${precinct}…`); results.replaceChildren();
    try {
      const { serviceAreaUrl, mode } = await getServiceAreaConfig();
      const response = await serviceArea.solve(serviceAreaUrl, new ServiceAreaParameters({ facilities: new FeatureSet({ features: [new Graphic({ geometry: graphic.geometry })] }), travelMode: mode, defaultBreaks: [app.config.minutes], outSpatialReference: app.view.spatialReference, trimOuterPolygon: true }));
      if (current !== requestNumber) return;
      const polygons = response.serviceAreaPolygons?.features || [];
      await areas.replaceFeatures(polygons.map((feature) => ({ geometry: feature.geometry, attributes: { precinct, minutes: app.config.minutes } })));
      setStatus(`10-minute driving coverage generated for NYPD Precinct ${precinct}: ${address}.`, "success");
    } catch (error) { if (current !== requestNumber) return; await areas.clear(); setStatus(`Unable to generate coverage: ${error?.message || "service-area request failed"}.`, "danger"); }
  };
  const renderMatches = (features) => results.replaceChildren(...features.map((feature) => {
    const item = document.createElement("calcite-list-item"); item.setAttribute("label", `NYPD Precinct ${String(feature.attributes?.POLICE_PREC ?? "Unknown")}`); item.setAttribute("description", String(feature.attributes?.FACILITY_ADDRESS ?? "Address not available")); item.addEventListener("click", () => solveForGraphic(feature)); return item;
  }));
  const searchStations = async () => {
    const term = String(input.value || "").trim(); if (!term) { setStatus("Enter a precinct number or part of a station address.", "warning"); results.replaceChildren(); return; }
    const escaped = term.replace(/'/g, "''").toUpperCase(); setStatus("Searching NYPD stations…"); results.replaceChildren();
    try {
      const query = stationLayer.createQuery(); query.where = `UPPER(FACILITY_ADDRESS) LIKE '%${escaped}%' OR CAST(POLICE_PREC AS VARCHAR(10)) = '${escaped}'`; query.outFields = fields; query.returnGeometry = true; query.orderByFields = ["POLICE_PREC ASC"];
      const { features } = await stationLayer.queryFeatures(query); if (!features.length) { setStatus("No NYPD station matched that search. Try a precinct number or more of the address.", "warning"); return; }
      renderMatches(features); setStatus(`${features.length} station${features.length === 1 ? "" : "s"} found. Choose one to generate coverage.`);
    } catch (error) { setStatus(`Station search failed: ${error?.message || "query error"}.`, "danger"); }
  };
  const registration = app.actions.register("solve-station-coverage", async ({ graphic }) => {
    const objectId = graphic.getObjectId();
    app.assert(objectId != null, "The selected station did not provide an object identifier.");
    const query = stationLayer.createQuery(); query.objectIds = [objectId]; query.outFields = fields; query.returnGeometry = true;
    const { features } = await stationLayer.queryFeatures(query); app.assert(features[0], "The selected NYPD station could not be retrieved."); await solveForGraphic(features[0]);
  });
  const onButton = () => searchStations(); const onKey = (event) => { if (event.key === "Enter") searchStations(); };
  button.addEventListener("click", onButton); input.addEventListener("keydown", onKey);
  app.onCleanup(() => { registration.remove(); button.removeEventListener("click", onButton); input.removeEventListener("keydown", onKey); mount.replaceChildren(); });
}