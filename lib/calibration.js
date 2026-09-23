/**
 * Optical Reference Scale Calibration
 * Converts pixel spans from photos with known reference objects (coins, cards, rulers)
 * into exact real-world millimeters for 3D CAD modeling.
 */

const STANDARD_REFERENCES = {
  quarter: { name: "US Quarter Dollar", mm: 24.26, type: "coin_diameter" },
  penny: { name: "US One Cent Penny", mm: 19.05, type: "coin_diameter" },
  nickel: { name: "US Five Cent Nickel", mm: 21.21, type: "coin_diameter" },
  dime: { name: "US Ten Cent Dime", mm: 17.91, type: "coin_diameter" },
  euro_1: { name: "1 Euro Coin", mm: 23.25, type: "coin_diameter" },
  euro_2: { name: "2 Euro Coin", mm: 25.75, type: "coin_diameter" },
  uk_1pound: { name: "UK 1 Pound Coin", mm: 23.03, type: "coin_diameter" },
  credit_card_w: { name: "Standard ID-1 Card Width", mm: 85.60, type: "card_width" },
  credit_card_h: { name: "Standard ID-1 Card Height", mm: 53.98, type: "card_height" },
  ruler_mm: { name: "Direct Metric Ruler", mm: 10.0, type: "ruler_span" }
};

const FIT_TOLERANCES = {
  press_fit: 0.10,   // Tight friction fit (dowels, pins)
  snap_fit: 0.20,    // Flex cantilever clips & latches
  slide_fit: 0.25,   // Standard sliding doors & battery covers (Default)
  loose_fit: 0.40    // Free moving hinges or rough draft prints
};

function calibrateScale(options = {}) {
  const refType = String(options.referenceType || "quarter").toLowerCase();
  const pixelSpan = Number(options.pixelSpan);

  if (!pixelSpan || isNaN(pixelSpan) || pixelSpan <= 0) {
    throw new Error("Invalid pixelSpan: Must be a positive number representing pixels in image");
  }

  let refMm = 0;
  let refName = "";

  if (refType === "custom_mm") {
    refMm = Number(options.customRefMm);
    if (!refMm || isNaN(refMm) || refMm <= 0) {
      throw new Error("custom_mm reference requires a positive customRefMm value in millimeters");
    }
    refName = `Custom Reference (${refMm} mm)`;
  } else if (STANDARD_REFERENCES[refType]) {
    refMm = STANDARD_REFERENCES[refType].mm;
    refName = STANDARD_REFERENCES[refType].name;
  } else {
    throw new Error(`Unknown referenceType "${refType}". Supported: ${Object.keys(STANDARD_REFERENCES).join(", ")}, custom_mm`);
  }

  const mmPerPixel = refMm / pixelSpan;
  const pixelsPerMm = pixelSpan / refMm;

  // Optical resolution quality estimate
  let precisionQuality = "high";
  if (pixelsPerMm < 5.0) {
    precisionQuality = "low (fewer than 5 px/mm; consider taking closer photo)";
  } else if (pixelsPerMm < 15.0) {
    precisionQuality = "moderate (10-15 px/mm; accurate to ~0.2mm)";
  } else {
    precisionQuality = "high (>=15 px/mm; excellent sub-millimeter accuracy)";
  }

  // Convert optional measurement list if supplied
  const converted = [];
  if (Array.isArray(options.measuredPixels)) {
    for (const item of options.measuredPixels) {
      if (item && item.pixelSpan && !isNaN(item.pixelSpan)) {
        const rawMm = Number(item.pixelSpan) * mmPerPixel;
        converted.push({
          label: item.label || "feature",
          pixels: Number(item.pixelSpan),
          rawMm: parseFloat(rawMm.toFixed(2)),
          recommendedWithClearance: {
            slide_fit: parseFloat((rawMm - (FIT_TOLERANCES.slide_fit * 2)).toFixed(2)),
            snap_fit: parseFloat((rawMm - (FIT_TOLERANCES.snap_fit * 2)).toFixed(2))
          }
        });
      }
    }
  }

  return {
    success: true,
    referenceUsed: refName,
    referenceMm: refMm,
    referencePixels: pixelSpan,
    scale: {
      mmPerPixel: parseFloat(mmPerPixel.toFixed(5)),
      pixelsPerMm: parseFloat(pixelsPerMm.toFixed(2)),
      precisionQuality
    },
    fitTolerances: FIT_TOLERANCES,
    measurements: converted
  };
}

module.exports = {
  calibrateScale,
  STANDARD_REFERENCES,
  FIT_TOLERANCES
};
