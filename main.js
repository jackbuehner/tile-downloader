import Map from "ol/Map.js";
import View from "ol/View.js";
import GeoJSON from "ol/format/GeoJSON.js";
import TileLayer from "ol/layer/Tile.js";
import VectorLayer from "ol/layer/Vector.js";
import { get as getProjection } from "ol/proj.js";
import { register } from "ol/proj/proj4.js";
import VectorSource from "ol/source/Vector.js";
import XYZ from "ol/source/XYZ.js";
import Fill from "ol/style/Fill.js";
import Stroke from "ol/style/Stroke.js";
import Style from "ol/style/Style.js";
import TileGrid from "ol/tilegrid/TileGrid.js";
import pLimit from "p-limit";
import proj4 from "proj4";
import { z } from "zod";
import "./style.css";

const metadataValidator = z.object({
  url: z.string(),
  name: z.string().optional(),
  nativeLevels: z.number().optional(),
  tileInfo: z.object({
    dpi: z.number(),
    lods: z
      .object({
        level: z.number(),
        resolution: z.number(),
        scale: z.number(),
      })
      .array(),
    origin: z.object({
      x: z.number(),
      y: z.number(),
      spatialReference: z.object({
        wkid: z.number(),
      }),
    }),
    size: z.array(z.number(), z.number()),
    spatialReference: z.object({
      wkid: z.number(),
    }),
  }),
});

// read the ArcGIS tile info from spec.json
const metadata = await fetch("spec.json")
  .then((response) => response.json())
  .then((data) => metadataValidator.parse(data))
  .then((data) => {
    if (!data.nativeLevels) {
      return data;
    }

    // if nativeLevels is present, filter lods to only include the native levels
    const nativeLods = data.tileInfo.lods.filter(
      (lod) => lod.level < data.nativeLevels
    );
    return {
      ...data,
      tileInfo: {
        ...data.tileInfo,
        lods: nativeLods,
      },
    };
  });

document.title = (
  (metadata.name || "") + " ArcGIS Tile Viewer & Downloader"
).trim();

// require the main spatial reference and the origin spatial reference to be the same
if (
  metadata.tileInfo.spatialReference.wkid !==
  metadata.tileInfo.origin.spatialReference.wkid
) {
  throw new Error(
    "Spatial reference WKID mismatch between main and origin spatial references."
  );
}

// find the proj4 string from the WKID using epsg.io
async function wkidToProj4(wkid) {
  const res = await fetch(`https://epsg.io/${wkid}.proj4`);
  if (!res.ok) throw new Error("Failed to fetch projection");
  const proj4Str = await res.text();
  proj4.defs(`EPSG:${wkid}`, proj4Str.trim());
  return proj4Str.trim();
}

// register the projections
const tilesEPSG = `EPSG:${metadata.tileInfo.spatialReference.wkid}`;
const mainProj4Str = await wkidToProj4(metadata.tileInfo.spatialReference.wkid);
proj4.defs(tilesEPSG, mainProj4Str);
register(proj4);

// Build tile grid from metadata
const tileGrid = new TileGrid({
  origin: [metadata.tileInfo.origin.x, metadata.tileInfo.origin.y],
  resolutions: metadata.tileInfo.lods.map((lod) => lod.resolution),
  tileSize: metadata.tileInfo.size,
});

// tiles
const layer = new TileLayer({
  source: new XYZ({
    projection: getProjection(tilesEPSG),
    tileGrid: tileGrid,
    url: `${metadata.url}/{z}/{y}/{x}`,
  }),
});

// area of interest
const vectorSource = new VectorSource({
  format: new GeoJSON(),
  url: "extent.geojson",
});
const vectorLayer = new VectorLayer({
  source: vectorSource,
  style: new Style({
    stroke: new Stroke({
      color: "red",
      width: 2,
    }),
    fill: new Fill({
      color: "rgba(255,0,0,0.1)",
    }),
  }),
});

const map = new Map({
  target: "map",
  layers: [layer, vectorLayer],
  view: new View({
    projection: getProjection(tilesEPSG),
    center: [2306103.8, 1793432.2],
    zoom: 16,
  }),
});

let logElement = document.getElementById("log");
if (!logElement) {
  logElement = document.createElement("div");
  logElement.id = "log";
  logElement.style.position = "absolute";
  logElement.style.bottom = "10px";
  logElement.style.left = "10px";
  logElement.style.backgroundColor = "rgba(255, 255, 255, 0.8)";
  logElement.style.padding = "10px";
  // logElement.style.maxHeight = "200px";
  // logElement.style.overflowY = "auto";
  logElement.textContent = "Loading tiles...";
  document.body.appendChild(logElement);
}

function setProgress(fraction, message = "") {
  logElement.textContent =
    message || `Progress: ${Math.round(fraction * 100)}%`;

  let progressBar = document.getElementById("progress-bar");
  if (!progressBar) {
    progressBar = document.createElement("div");
    progressBar.id = "progress-bar";
    progressBar.style.position = "relative";
    progressBar.style.width = "100%";
    progressBar.style.height = "20px";
    progressBar.style.marginTop = "10px";
    progressBar.style.backgroundColor = "#ccc";
    logElement.appendChild(progressBar);
  }

  let filledBar = document.getElementById("filled-bar");
  if (!filledBar) {
    filledBar = document.createElement("div");
    filledBar.id = "filled-bar";
    filledBar.style.height = "100%";
    filledBar.style.backgroundColor = "#4caf50";
    filledBar.style.transition = "width 0.3s ease";
    filledBar.style.position = "absolute";
    filledBar.style.top = "0";
    filledBar.style.left = "0";
  }
  filledBar.style.width = `${fraction * 100}%`;
  progressBar.appendChild(filledBar);

  let barPercentage = document.getElementById("bar-percentage");
  if (!barPercentage) {
    barPercentage = document.createElement("span");
    barPercentage.id = "bar-percentage";
    barPercentage.style.position = "absolute";
    barPercentage.style.top = "0";
    barPercentage.style.left = "50%";
    barPercentage.style.transform = "translateX(-50%)";
    barPercentage.style.color = "#fff"; // white text
    barPercentage.style.webkitTextStroke = "0.36px black"; // shadow for better visibility
    progressBar.appendChild(barPercentage);
  }
  barPercentage.textContent = `${(fraction * 100).toFixed(1)}%`;
}

vectorSource.once("change", () => {
  if (vectorSource.getState() === "ready") {
    const button = document.createElement("button");
    button.textContent = "Download All Levels";
    button.addEventListener("click", downloadAllLevelsForArcGIS);
    button.style.position = "absolute";
    button.style.top = "10px";
    button.style.right = "10px";
    button.style.zIndex = "1000"; // ensure it is above the map
    document.body.appendChild(button);

    setProgress(0, "Ready to download tiles.");
  }
});

/**
 * Calculate the tile range for a given extent and resolution.
 *
 * @param {*} extent
 * @param {*} resolution
 * @returns
 */
function tileRangeForExtent(extent, resolution) {
  const [xmin, ymin, xmax, ymax] = extent;
  const [originX, originY] = tileGrid.getOrigin();

  let tileSize = tileGrid.getTileSize();
  if (Array.isArray(tileSize)) {
    tileSize = tileSize[0]; // assuming square tiles, use the first dimension
  }

  const minX = Math.floor((xmin - originX) / (resolution * tileSize));
  const maxX = Math.floor((xmax - originX) / (resolution * tileSize));
  const minY = Math.floor((originY - ymax) / (resolution * tileSize));
  const maxY = Math.floor((originY - ymin) / (resolution * tileSize));
  return { minX, maxX, minY, maxY };
}

/**
 * Converts z, x, y to ArcGIS tile cache naming convention.
 * @param {*} z
 * @param {*} x
 * @param {*} y
 * @returns
 */
function toArcGISNames(z, x, y) {
  const L = "L" + z.toString().padStart(2, "0");
  const R = "R" + y.toString(16).padStart(8, "0").toUpperCase();
  const C = "C" + x.toString(16).padStart(8, "0").toUpperCase();
  return { L, R, C };
}

/**
 * Downloads all tiles for all levels in the ArcGIS tile cache naming scheme.
 *
 * To convert a particular scale to a singular raster, use GDAL.
 * Each zoom level folder has a `convert.sh` script that can be run to convert
 * the tiles to a single raster.
 */
async function downloadAllLevelsForArcGIS() {
  if (!window.showDirectoryPicker) {
    alert(
      "Your browser does not support the File System API. Please use a modern browser with support for the File System Access API."
    );
    return;
  }

  alert(
    "This will download all tiles.\n\nYou MUST respect the license of this imagery. If the imagery source is restricted to personal use, you may not use this tool to download the imagery for commerical purposes or re-hosting.\n\nYou browser will prompt you for a location to download the tiles. Your browser must support the File System API."
  );

  const dirHandle = await window.showDirectoryPicker();
  const allLayers = await dirHandle.getDirectoryHandle("_alllayers", {
    create: true,
  });

  let tileSize = tileGrid.getTileSize();
  if (Array.isArray(tileSize)) {
    tileSize = tileSize[0]; // assuming square tiles, use the first dimension
  }

  const bbox = vectorSource.getExtent();

  const totalTiles = metadata.tileInfo.lods.reduce((acc, lod) => {
    const { minX, maxX, minY, maxY } = tileRangeForExtent(bbox, lod.resolution);
    return acc + (maxX - minX + 1) * (maxY - minY + 1);
  }, 0);
  let downloadedTiles = 0;

  for await (const lod of metadata.tileInfo.lods) {
    const { level, resolution } = lod;
    const { minX, maxX, minY, maxY } = tileRangeForExtent(bbox, resolution);

    const Ldir = await allLayers.getDirectoryHandle(
      "L" + level.toString().padStart(2, "0"),
      { create: true }
    );

    const totalLevelTiles = (maxX - minX + 1) * (maxY - minY + 1);
    let downloadedLevelTiles = 0;
    setProgress(
      0,
      `Downloading tiles for LOD Level: ${level} (${totalTiles} tiles) [${metadata.tileInfo.lods.length} levels]`
    );

    const limit = pLimit(10); // max 10 concurrent downloads

    const tasks = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tasks.push(
          limit(async () => {
            const url = `${metadata.url}/${lod.level}/${y}/${x}`;
            try {
              const { R, C } = toArcGISNames(lod.level, x, y);
              const filePath = (ext) => `${R}${C}.${ext}`;

              // check if the file already exists (check png or jpeg)
              const pngExists = await Ldir.getFileHandle(filePath("png"), {
                create: false,
              })
                .then(() => true)
                .catch(() => false);
              const jpegExists = await Ldir.getFileHandle(filePath("jpeg"), {
                create: false,
              })
                .then(() => true)
                .catch(() => false);

              let imageFileType = pngExists
                ? "png"
                : jpegExists
                ? "jpeg"
                : null;

              // if the file does not exist, download it
              if (!pngExists && !jpegExists) {
                const resp = await fetch(url);
                if (resp.ok) {
                  const contentType = resp.headers.get("Content-Type");
                  imageFileType = contentType === "image/png" ? "png" : "jpeg";
                  const fileHandle = await Ldir.getFileHandle(
                    filePath(imageFileType),
                    {
                      create: true,
                    }
                  );
                  const writable = await fileHandle.createWritable();
                  await resp.body.pipeTo(writable);
                }
              }

              // create a world file (georeferencing information) for each tile
              const worldFileHandle = await Ldir.getFileHandle(
                filePath(imageFileType === "png" ? "pgw" : "jgw"),
                {
                  create: true,
                }
              );
              const worldFileContent = [
                resolution.toFixed(6), // pixel size in the x-direction
                "0", // rotation about the y-axis
                "0", // rotation about the x-axis
                -resolution.toFixed(6), // pixel size in the y-direction (negative for north-up)
                metadata.tileInfo.origin.x + x * resolution * tileSize, // x-coordinate of the upper left corner
                metadata.tileInfo.origin.y - y * resolution * tileSize, // y-coordinate of the upper left corner
              ].join("\n");
              const worldFileWritable = await worldFileHandle.createWritable();
              await worldFileWritable.write(worldFileContent);
              await worldFileWritable.close();

              downloadedTiles++;
              downloadedLevelTiles++;
              setProgress(
                downloadedTiles / totalTiles,
                `Downloading tiles for LOD Level: ${level} (${downloadedLevelTiles}/${totalLevelTiles} tiles) [${metadata.tileInfo.lods.length} levels]`
              );
            } catch (err) {
              console.warn("Missing tile:", url);
            }
          })
        );
      }
    }

    await Promise.all(tasks);

    // write an shell script file to convert the tiles in the level of detail directory
    // to a single raster using GDAL
    const scriptHandle = await Ldir.getFileHandle("convert.sh", {
      create: true,
    });
    const scriptContent = `#!/bin/bash
# This script converts all tiles in this directory to a single raster using GDAL.
find . -type f \\( -name "*.png" -o -name "*.jpeg" \\) > filelist.txt
gdalbuildvrt -addalpha -input_file_list filelist.txt mosaic.vrt
gdal_translate -of GTiff -a_srs ${tilesEPSG} mosaic.vrt mosaic.tiff
rm filelist.txt
rm mosaic.vrt
`;
    const scriptWritable = await scriptHandle.createWritable();
    await scriptWritable.write(scriptContent);
    await scriptWritable.close();
    console.debug(`Created conversion script for LOD Level: ${level}`);
  }
}
