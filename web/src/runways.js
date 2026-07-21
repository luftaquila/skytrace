// South Korean airport runways from OurAirports open data (public domain).
// Regenerate with scripts/build-runways.mjs. Coordinates are threshold [lon, lat];
// len/width in feet; elevFt is threshold elevation (null when unknown).
//
// @typedef {Object} Runway
// @property {string} icao  Owning airport ICAO (matches AIRFIELDS[].icao).
// @property {string} ident e.g. "16/34".
// @property {number} len   Length, feet.
// @property {number} width Width, feet.
// @property {?number} elevFt
// @property {[number, number]} le  Low-end threshold [lon, lat].
// @property {[number, number]} he  High-end threshold [lon, lat].

/** @type {Runway[]} */
export const RUNWAYS = [
  {icao: "RKJB", ident: "01/19", len: 9186, width: 150, elevFt: 32, le: [126.382912, 34.978825], he: [126.382706, 35.004005]},
  {icao: "RKJJ", ident: "04L/22R", len: 9300, width: 150, elevFt: 44, le: [126.800003, 35.1157], he: [126.817001, 35.137299]},
  {icao: "RKJJ", ident: "04R/22L", len: 9300, width: 150, elevFt: 43, le: [126.802002, 35.114799], he: [126.818001, 35.136902]},
  {icao: "RKJK", ident: "18/36", len: 9000, width: 150, elevFt: 20, le: [126.612999, 35.915901], he: [126.619003, 35.891602]},
  {icao: "RKJM", ident: "06/24", len: 5249, width: 98, elevFt: 12, le: [126.373001, 34.754299], he: [126.387001, 34.7635]},
  {icao: "RKJU", ident: "07/25", len: 4800, width: 100, elevFt: null, le: [127.112, 35.875999], he: [127.126999, 35.880901]},
  {icao: "RKJY", ident: "17/35", len: 6890, width: 148, elevFt: 28, le: [127.612999, 34.851101], he: [127.621002, 34.833599]},
  {icao: "RKNN", ident: "08/26", len: 9000, width: 150, elevFt: 35, le: [128.929001, 37.749001], he: [128.957993, 37.758099]},
  {icao: "RKNW", ident: "03/21", len: 9000, width: 150, elevFt: 323, le: [127.954002, 37.426998], he: [127.967003, 37.4491]},
  {icao: "RKNY", ident: "15/33", len: 8202, width: 148, elevFt: 230, le: [128.660004, 38.070099], he: [128.677994, 38.052601]},
  {icao: "RKPC", ident: "07/25", len: 10433, width: 148, elevFt: 86, le: [126.469002, 33.500401], he: [126.497002, 33.5145]},
  {icao: "RKPC", ident: "13/31", len: 6268, width: 148, elevFt: 67, le: [126.487, 33.515499], he: [126.503998, 33.505501]},
  {icao: "RKPD", ident: "01/19", len: 7589, width: 149, elevFt: 1102, le: [126.711998, 33.3829], he: [126.711998, 33.403702]},
  {icao: "RKPD", ident: "15/33", len: 4974, width: 80, elevFt: 1170, le: [126.708, 33.4039], he: [126.718002, 33.393101]},
  {icao: "RKPE", ident: "18/36", len: 3766, width: 78, elevFt: null, le: [128.695007, 35.145802], he: [128.697006, 35.136101]},
  {icao: "RKPK", ident: "18R/36L", len: 10499, width: 197, elevFt: 12, le: [128.934998, 35.193901], he: [128.938995, 35.165199]},
  {icao: "RKPK", ident: "18L/36R", len: 9007, width: 150, elevFt: 8, le: [128.936996, 35.194099], he: [128.940994, 35.169498]},
  {icao: "RKPS", ident: "06L/24R", len: 9000, width: 150, elevFt: 18, le: [128.057007, 35.082199], he: [128.082001, 35.096199]},
  {icao: "RKPS", ident: "06R/24L", len: 9000, width: 150, elevFt: 19, le: [128.059998, 35.081299], he: [128.085007, 35.0952]},
  {icao: "RKPU", ident: "18/36", len: 6561, width: 148, elevFt: 45, le: [129.350998, 35.602501], he: [129.352005, 35.584499]},
  {icao: "RKRA", ident: "18/36", len: 3915, width: 115, elevFt: 284, le: [126.988998, 37.8358], he: [126.989998, 37.8251]},
  {icao: "RKRB", ident: "17/35", len: 1608, width: 92, elevFt: null, le: [126.746002, 37.476898], he: [126.748001, 37.473]},
  {icao: "RKRG", ident: "15/33", len: 1600, width: 100, elevFt: null, le: [127.627998, 37.5033], he: [127.630997, 37.499699]},
  {icao: "RKRK", ident: "16/34", len: 1515, width: 76, elevFt: null, le: [127.356003, 37.813599], he: [127.358002, 37.8097]},
  {icao: "RKRN", ident: "10L/28R", len: 5314, width: 98, elevFt: null, le: [127.466003, 37.197399], he: [127.484001, 37.197498]},
  {icao: "RKRN", ident: "10R/28L", len: 1640, width: 98, elevFt: null, le: [127.471001, 37.1964], he: [127.475998, 37.1964]},
  {icao: "RKRP", ident: "16/34", len: 1620, width: 55, elevFt: null, le: [126.792, 37.764599], he: [126.793999, 37.760601]},
  {icao: "RKSG", ident: "14/32", len: 8217, width: 150, elevFt: 47, le: [127.021004, 36.9697], he: [127.042, 36.9548]},
  {icao: "RKSI", ident: "16L/34R", len: 13123, width: 197, elevFt: null, le: [126.415631, 37.47274], he: [126.441697, 37.443432]},
  {icao: "RKSI", ident: "15L/33R", len: 12303, width: 197, elevFt: 23, le: [126.440002, 37.483898], he: [126.464996, 37.456402]},
  {icao: "RKSI", ident: "15R/33L", len: 12303, width: 197, elevFt: 23, le: [126.435997, 37.4818], he: [126.460999, 37.454201]},
  {icao: "RKSI", ident: "16R/34L", len: 12303, width: 197, elevFt: 23, le: [126.413446, 37.468746], he: [126.437882, 37.441272]},
  {icao: "RKSM", ident: "02/20", len: 9700, width: 150, elevFt: 56, le: [127.111, 37.432499], he: [127.114998, 37.458801]},
  {icao: "RKSM", ident: "01/19", len: 9000, width: 150, elevFt: 49, le: [127.115997, 37.433899], he: [127.115997, 37.458801]},
  {icao: "RKSO", ident: "09L/27R", len: 9004, width: 150, elevFt: 41, le: [127.013998, 37.091243], he: [127.044659, 37.093801]},
  {icao: "RKSO", ident: "09R/27L", len: 9004, width: 150, elevFt: 33, le: [127.014236, 37.089332], he: [127.04491, 37.091887]},
  {icao: "RKSS", ident: "14L/32R", len: 11811, width: 148, elevFt: 38, le: [126.778, 37.570301], he: [126.806999, 37.547401]},
  {icao: "RKSS", ident: "14R/32L", len: 10499, width: 197, elevFt: 34, le: [126.776001, 37.568001], he: [126.801003, 37.5476]},
  {icao: "RKSW", ident: "15L/33R", len: 9000, width: 150, elevFt: 86, le: [126.998001, 37.249599], he: [127.016998, 37.230099]},
  {icao: "RKSW", ident: "15R/33L", len: 9000, width: 150, elevFt: 83, le: [126.997002, 37.248699], he: [127.015999, 37.229198]},
  {icao: "RKSW", ident: "16/34", len: 7535, width: 143, elevFt: null, le: [127.019997, 37.237099], he: [127.028999, 37.217899]},
  {icao: "RKTA", ident: "16/34", len: 3871, width: 82, elevFt: null, le: [126.294147, 36.598694], he: [126.299092, 36.588866]},
  {icao: "RKTE", ident: "16/34", len: 4000, width: 120, elevFt: null, le: [127.497002, 36.5732], he: [127.502998, 36.563099]},
  {icao: "RKTH", ident: "10/28", len: 7000, width: 150, elevFt: 63, le: [129.408997, 35.987701], he: [129.432007, 35.987999]},
  {icao: "RKTI", ident: "18R/36L", len: 9330, width: 120, elevFt: 281, le: [127.883003, 37.042702], he: [127.885002, 37.0172]},
  {icao: "RKTI", ident: "18L/36R", len: 9021, width: 200, elevFt: 281, le: [127.885002, 37.0424], he: [127.888, 37.0177]},
  {icao: "RKTN", ident: "13R/31L", len: 9039, width: 150, elevFt: 111, le: [128.645996, 35.9006], he: [128.671005, 35.8867]},
  {icao: "RKTN", ident: "13L/31R", len: 9000, width: 150, elevFt: 112, le: [128.647003, 35.9016], he: [128.671997, 35.8876]},
  {icao: "RKTP", ident: "03L/21R", len: 9000, width: 150, elevFt: 39, le: [126.478996, 36.694], he: [126.490997, 36.716301]},
  {icao: "RKTP", ident: "03R/21L", len: 9000, width: 150, elevFt: 39, le: [126.481003, 36.693199], he: [126.494003, 36.715599]},
  {icao: "RKTU", ident: "06L/24R", len: 9000, width: 200, elevFt: 166, le: [127.487, 36.710098], he: [127.511002, 36.7253]},
  {icao: "RKTU", ident: "06R/24L", len: 9000, width: 150, elevFt: 191, le: [127.487999, 36.707901], he: [127.511002, 36.7229]},
  {icao: "RKTY", ident: "10/28", len: 9000, width: 150, elevFt: 347, le: [128.339996, 36.631699], he: [128.369995, 36.632198]},
  {icao: "RKUC", ident: "14/32", len: 3100, width: 120, elevFt: 82, le: [127.292, 36.574501], he: [127.299004, 36.5686]},
  {icao: "RKUL", ident: "11L/29R", len: 3937, width: 150, elevFt: null, le: [127.107002, 36.270699], he: [127.120003, 36.2682]},
  {icao: "RKUL", ident: "11R/29L", len: 1476, width: 105, elevFt: null, le: [127.108002, 36.269299], he: [127.112999, 36.267899]},
];
