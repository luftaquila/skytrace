// South Korean airfields — location and codes for the map reference overlay.
// Source: OurAirports open data (public domain), filtered to iso_country=KR,
// types large/medium/small_airport, cleaned to the Korea bounding box and
// deduplicated by proximity. `icao`/`iata` are null when no official code
// exists (military helipads, emergency strips); such fields have minor=true.
// Regenerate with scripts/build-airfields.mjs if the source data changes.

/**
 * @typedef {Object} Airfield
 * @property {string} code   Best display code: IATA, else ICAO, else raw ident.
 * @property {?string} icao  Official ICAO code (RKxx) or null.
 * @property {?string} iata  Official IATA code or null.
 * @property {string} name
 * @property {"large"|"medium"|"small"} kind
 * @property {?string} city
 * @property {number} lat
 * @property {number} lon
 */

/** @type {Airfield[]} */
export const AIRFIELDS = [
  {code: "CJJ", icao: "RKTU", iata: "CJJ", name: "Cheongju International Airport/Cheongju Air Base (K-59/G-513)", kind: "large", city: "Cheongju", lat: 36.71556, lon: 127.50029},
  {code: "CJU", icao: "RKPC", iata: "CJU", name: "Jeju International Airport", kind: "large", city: "Jeju City", lat: 33.51206, lon: 126.49255},
  {code: "GMP", icao: "RKSS", iata: "GMP", name: "Seoul Gimpo International Airport", kind: "large", city: "Seoul", lat: 37.5583, lon: 126.791},
  {code: "ICN", icao: "RKSI", iata: "ICN", name: "Incheon International Airport", kind: "large", city: "Seoul", lat: 37.4691, lon: 126.451},
  {code: "MWX", icao: "RKJB", iata: "MWX", name: "Muan International Airport", kind: "large", city: "Muan (Piseo-ri)", lat: 34.99141, lon: 126.38281},
  {code: "PUS", icao: "RKPK", iata: "PUS", name: "Gimhae International Airport", kind: "large", city: "Busan", lat: 35.1795, lon: 128.938},
  {code: "TAE", icao: "RKTN", iata: "TAE", name: "Daegu International Airport", kind: "large", city: "Daegu", lat: 35.89439, lon: 128.65699},
  {code: "YNY", icao: "RKNY", iata: "YNY", name: "Yangyang International Airport", kind: "large", city: "Gonghang-ro", lat: 38.06048, lon: 128.66982},
  {code: "HIN", icao: "RKPS", iata: "HIN", name: "Sacheon Airport / Sacheon Air Base", kind: "medium", city: "Sacheon", lat: 35.08859, lon: 128.07175},
  {code: "JDG", icao: "RKPD", iata: "JDG", name: "Jeongseok Airport", kind: "medium", city: "Jeju Island", lat: 33.3996, lon: 126.712},
  {code: "JWO", icao: "RKTI", iata: "JWO", name: "Jungwon Air Base/Chungju Airport", kind: "medium", city: "Gimseang-ro", lat: 37.03024, lon: 127.88635},
  {code: "KAG", icao: "RKNN", iata: "KAG", name: "Gangneung Airport (K-18)", kind: "medium", city: "Gangneung", lat: 37.7536, lon: 128.94392},
  {code: "KPO", icao: "RKTH", iata: "KPO", name: "Pohang Airport (G-815/K-3)", kind: "medium", city: "Pohang", lat: 35.98796, lon: 129.42038},
  {code: "KR-1109", icao: null, iata: null, name: "Naju Juksanbo Airfield", kind: "medium", city: "Naju-si (Naju City)", lat: 34.973, lon: 126.61712},
  {code: "KUV", icao: "RKJK", iata: "KUV", name: "Gunsan Airport / Gunsan Air Base", kind: "medium", city: "Gunsan", lat: 35.9038, lon: 126.616},
  {code: "KWJ", icao: "RKJJ", iata: "KWJ", name: "Gwangju Airport", kind: "medium", city: "Gwangju", lat: 35.12317, lon: 126.80544},
  {code: "OSN", icao: "RKSO", iata: "OSN", name: "Osan Air Base", kind: "medium", city: "Pyeongtaek", lat: 37.09146, lon: 127.02945},
  {code: "RKSG", icao: "RKSG", iata: null, name: "Camp Humphreys (A-511) Desiderio Army Airfield", kind: "medium", city: "Pyeongtaek", lat: 36.96236, lon: 127.03113},
  {code: "RSU", icao: "RKJY", iata: "RSU", name: "Yeosu Airport", kind: "medium", city: "Yeosu", lat: 34.8423, lon: 127.617},
  {code: "SSN", icao: "RKSM", iata: "SSN", name: "Seoul Air Base (K-16)", kind: "medium", city: "Seongnam", lat: 37.44474, lon: 127.11272},
  {code: "SWU", icao: "RKSW", iata: "SWU", name: "Suwon Airport", kind: "medium", city: "Suwon", lat: 37.2394, lon: 127.007},
  {code: "USN", icao: "RKPU", iata: "USN", name: "Ulsan Airport", kind: "medium", city: "Ulsan", lat: 35.5935, lon: 129.35201},
  {code: "WJU", icao: "RKNW", iata: "WJU", name: "Wonju Airport / Hoengseong Air Base (K-38/K-46)", kind: "medium", city: "Wonju", lat: 37.43711, lon: 127.96005},
  {code: "YEC", icao: "RKTY", iata: "YEC", name: "Yecheon Airbase", kind: "medium", city: "Yecheon-ri", lat: 36.63037, lon: 128.34971},
  {code: "CHF", icao: "RKPE", iata: "CHF", name: "Jinhae Air Base", kind: "small", city: "Jinhae", lat: 35.14025, lon: 128.69623},
  {code: "CHN", icao: "RKJU", iata: "CHN", name: "Jeonju (G 703) Air Base", kind: "small", city: "Jeonju", lat: 35.87829, lon: 127.11894},
  {code: "HMY", icao: "RKTP", iata: "HMY", name: "Seosan Air Base", kind: "small", city: "Seosan", lat: 36.704, lon: 126.486},
  {code: "KR-0011", icao: null, iata: null, name: "Jukbyeon Emergency Airstrip", kind: "small", city: "Jukbyeon-myeon", lat: 37.05953, lon: 129.40929},
  {code: "KR-0017", icao: null, iata: null, name: "Yeongam Airport", kind: "small", city: "Yeongam", lat: 34.69597, lon: 126.51954},
  {code: "KR-0041", icao: null, iata: null, name: "Alddreu Airfield (K-40) (Cheju-do No. 2)", kind: "small", city: null, lat: 33.20394, lon: 126.27132},
  {code: "KR-0199", icao: null, iata: null, name: "Imdang-ri Airfield", kind: "small", city: "Imdang-ri", lat: 38.19605, lon: 128.04194},
  {code: "KR-0207", icao: null, iata: null, name: "G-321 Airfield", kind: "small", city: "Mahyeon-ri", lat: 38.26897, lon: 127.55613},
  {code: "KR-0257", icao: null, iata: null, name: "Chodang University Sani Airport (Yeongnong Airport)", kind: "small", city: "Haenam (Sani-myeon)", lat: 34.62773, lon: 126.42019},
  {code: "KR-0285", icao: null, iata: null, name: "Jeju  ROK Naval Air Facility", kind: "small", city: "Yongdami-dong", lat: 33.51078, lon: 126.49913},
  {code: "KR-0299", icao: null, iata: null, name: "Sky Nuri Flight School Airstrip", kind: "small", city: "Hwaseong", lat: 37.10731, lon: 126.7644},
  {code: "KR-0331", icao: null, iata: null, name: "Gyeryongdae Emergency Airfield", kind: "small", city: "Gyeryong", lat: 36.31421, lon: 127.2343},
  {code: "KR-0611", icao: null, iata: null, name: "Yeongju Emergency Runway Airfield", kind: "small", city: "Sangjul-dong", lat: 36.83759, lon: 128.57961},
  {code: "KR-1054", icao: null, iata: null, name: "Jinhae Naval Academy Airfield", kind: "small", city: "Jinhae", lat: 35.12858, lon: 128.66355},
  {code: "KR-1055", icao: null, iata: null, name: "Goheung Airport", kind: "small", city: "Dodeok-myeon", lat: 34.61128, lon: 127.20563},
  {code: "KR-1056", icao: null, iata: null, name: "Jeonju Airfield", kind: "small", city: "Jeonju", lat: 35.88025, lon: 127.01474},
  {code: "KR-1057", icao: null, iata: null, name: "SL Air Airstrip", kind: "small", city: "Namweon", lat: 35.45041, lon: 127.43346},
  {code: "KR-1058", icao: null, iata: null, name: "Hwangryong Airport", kind: "small", city: "Hwangryong-myeon", lat: 35.27741, lon: 126.75491},
  {code: "KR-1108", icao: null, iata: null, name: "Leisure Aviation Art Airstrip", kind: "small", city: "Anseong", lat: 36.98393, lon: 127.19686},
  {code: "KR-1114", icao: null, iata: null, name: "Ulleung Airport", kind: "small", city: "Ulleung-Gun (Ulleung County)", lat: 37.45506, lon: 130.87683},
  {code: "KR-1116", icao: null, iata: null, name: "Yeongdeok Educational Airstrip", kind: "small", city: "Yeongdeok-Gun (Yeongdeok County)", lat: 36.55254, lon: 129.40255},
  {code: "KR-1119", icao: null, iata: null, name: "Gongju Flight Education and Training Center", kind: "small", city: "Gongju-Si (Gongju City)", lat: 36.62006, lon: 127.29582},
  {code: "KR-1120", icao: null, iata: null, name: "Haman takeoff and landing pad", kind: "small", city: "Haman-Gun (Haman County)", lat: 35.33078, lon: 128.38781},
  {code: "QJP", icao: null, iata: "QJP", name: "Pocheon (G-217) Airport", kind: "small", city: "Pocheon", lat: 37.86456, lon: 127.17663},
  {code: "RK13", icao: null, iata: null, name: "Yanggu (G-404) Airport", kind: "small", city: "Yanggu", lat: 38.08657, lon: 127.98682},
  {code: "RK14", icao: null, iata: null, name: "Idong Airport (G-231)", kind: "small", city: "Idong-myeon", lat: 38.0266, lon: 127.367},
  {code: "RK15", icao: null, iata: null, name: "Ji Po Ri Airfield (G-237)", kind: "small", city: "Witguntan", lat: 38.15504, lon: 127.31408},
  {code: "RK16", icao: null, iata: null, name: "G-312 Airport", kind: "small", city: "Sanae-myeon", lat: 38.07574, lon: 127.52112},
  {code: "RK17", icao: null, iata: null, name: "G-406 Airport", kind: "small", city: "Jukgok-ro", lat: 38.13965, lon: 128.00912},
  {code: "RK18", icao: null, iata: null, name: "G 233 Airport", kind: "small", city: "Munam", lat: 38.08316, lon: 127.26904},
  {code: "RK19", icao: null, iata: null, name: "G-314 Airport", kind: "small", city: "Hwacheon", lat: 38.13988, lon: 127.74011},
  {code: "RK21", icao: null, iata: null, name: "G-413 Airport", kind: "small", city: "Goseong", lat: 38.38254, lon: 128.45807},
  {code: "RK22", icao: null, iata: null, name: "G-313 Airport", kind: "small", city: "Hwacheon", lat: 38.12002, lon: 127.68607},
  {code: "RK27", icao: null, iata: null, name: "G-218 Airport", kind: "small", city: "Gaenari", lat: 37.89502, lon: 126.97052},
  {code: "RK28", icao: null, iata: null, name: "G-219 Airport", kind: "small", city: "Samnyuksa-ro", lat: 37.90939, lon: 127.00846},
  {code: "RK31", icao: null, iata: null, name: "G-307 Airport", kind: "small", city: "Yulmun-ri", lat: 37.92953, lon: 127.75737},
  {code: "RK32", icao: null, iata: null, name: "G-420 Airport", kind: "small", city: "Girin-myeon", lat: 37.95618, lon: 128.31645},
  {code: "RK33", icao: null, iata: null, name: "G-418 Airport", kind: "small", city: "Yudong-ri", lat: 37.34462, lon: 128.38409},
  {code: "RK34", icao: null, iata: null, name: "G 417 Airport", kind: "small", city: "Jinbeol", lat: 37.65004, lon: 128.56961},
  {code: "RK36", icao: null, iata: null, name: "G 238 Airport", kind: "small", city: "Dosin-ri, Sinsei-myeon, Yeoncheon", lat: 38.17665, lon: 127.10214},
  {code: "RK38", icao: null, iata: null, name: "Baekui-ri (G-228) Airfield", kind: "small", city: "Gososeong-ri", lat: 38.02895, lon: 127.14159},
  {code: "RK40", icao: null, iata: null, name: "G-240 Airport", kind: "small", city: "Cheongyang-ri", lat: 38.24881, lon: 127.37827},
  {code: "RK41", icao: null, iata: null, name: "G-317 Airport", kind: "small", city: "Hwacheon", lat: 38.2163, lon: 127.65661},
  {code: "RK42", icao: null, iata: null, name: "G-311 Airport", kind: "small", city: "Gandong-myeon", lat: 38.05585, lon: 127.79738},
  {code: "RK43", icao: null, iata: null, name: "G-414 Airport", kind: "small", city: "Ipyeong-ro", lat: 38.10619, lon: 128.201},
  {code: "RK44", icao: null, iata: null, name: "G-412 Airport", kind: "small", city: "Hyeonchon", lat: 38.23978, lon: 128.20829},
  {code: "RK48", icao: null, iata: null, name: "G-419 Airport", kind: "small", city: "Hongcheon-ro", lat: 37.70315, lon: 127.90461},
  {code: "RK49", icao: null, iata: null, name: "G 530 Airport", kind: "small", city: "Taean", lat: 36.75652, lon: 126.32886},
  {code: "RK50", icao: null, iata: null, name: "G 526 Airport", kind: "small", city: "Hongseong-eup", lat: 36.58816, lon: 126.65841},
  {code: "RK51", icao: null, iata: null, name: "G 532 Airport", kind: "small", city: "Sejong", lat: 36.54161, lon: 127.28583},
  {code: "RK52", icao: null, iata: null, name: "Yongin (G-501) Airport", kind: "small", city: "Pogong-ro", lat: 37.28675, lon: 127.22545},
  {code: "RK60", icao: null, iata: null, name: "G 712 Airport", kind: "small", city: "Yeonggwang-eup", lat: 35.30661, lon: 126.49496},
  {code: "RK6D", icao: null, iata: null, name: "G 710 Airport", kind: "small", city: "Geumseong-myeon", lat: 35.3421, lon: 127.03},
  {code: "RK6O", icao: null, iata: null, name: "Jecheon (G-605) Airport", kind: "small", city: "Jecheon", lat: 37.16283, lon: 128.21925},
  {code: "RK6X", icao: null, iata: null, name: "Nogok-ri Airfield (G-130)", kind: "small", city: "Nogok-ri", lat: 37.99357, lon: 126.91917},
  {code: "RK82", icao: null, iata: null, name: "G-405 Airport", kind: "small", city: "Yongha-ri", lat: 38.11974, lon: 128.04025},
  {code: "RKCH", icao: "RKCH", iata: null, name: "Namji", kind: "small", city: "Namji", lat: 35.42927, lon: 128.51038},
  {code: "RKJM", icao: "RKJM", iata: null, name: "Mokpo Air Base", kind: "small", city: "Gonghang-ro (Mokpo)", lat: 34.75898, lon: 126.38032},
  {code: "RKRA", icao: "RKRA", iata: null, name: "Ganap-ri (G-222) Airport", kind: "small", city: "Ganap-ri", lat: 37.83006, lon: 126.99013},
  {code: "RKRB", icao: "RKRB", iata: null, name: "Bucheon (G-103) Airfield", kind: "small", city: "Ilsin-ro", lat: 37.47492, lon: 126.74727},
  {code: "RKRG", icao: "RKRG", iata: null, name: "Yangpyeong (G-301) Airport", kind: "small", city: "Yangpyeong", lat: 37.50117, lon: 127.63021},
  {code: "RKRK", icao: "RKRK", iata: null, name: "G-213 Airport", kind: "small", city: "Ha-myeon", lat: 37.81282, lon: 127.35711},
  {code: "RKRN", icao: "RKRN", iata: null, name: "Icheon (G-510) Airfield", kind: "small", city: "Jinsangmi-ro", lat: 37.20072, lon: 127.46922},
  {code: "RKRP", icao: "RKRP", iata: null, name: "Paju (G-110) Airport", kind: "small", city: "Paju", lat: 37.76349, lon: 126.79255},
  {code: "RKRS", icao: "RKRS", iata: null, name: "Susaek (G 113) Airport", kind: "small", city: "Goyang", lat: 37.60054, lon: 126.86952},
  {code: "RKST", icao: "RKST", iata: null, name: "Camp Casey-Dongduchon (Camp Mobile) (H-220) Airfield", kind: "small", city: "Dongduchon", lat: 37.92149, lon: 127.0555},
  {code: "RKTA", icao: "RKTA", iata: null, name: "Taean Airport", kind: "small", city: "Taean", lat: 36.59378, lon: 126.29662},
  {code: "RKTE", icao: "RKTE", iata: null, name: "Seongmu Airport", kind: "small", city: null, lat: 36.5682, lon: 127.5},
  {code: "RKTS", icao: "RKTS", iata: null, name: "Sangju Airfield", kind: "small", city: "Sangju", lat: 36.40745, lon: 128.17716},
  {code: "RKUC", icao: "RKUC", iata: null, name: "Jochiwon (G-505) Airfield", kind: "small", city: "Jochiwon", lat: 36.57195, lon: 127.29607},
  {code: "RKUL", icao: "RKUL", iata: null, name: "G 536 Airport", kind: "small", city: "Songdang-ri", lat: 36.26709, lon: 127.10888},
  {code: "UJN", icao: "RKTL", iata: "UJN", name: "Uljin Airport", kind: "small", city: "Bongsan-ri, Uljin", lat: 36.77705, lon: 129.46186},
];

/** True for fields with no official ICAO/IATA code (minor military/emergency strips). */
export const isMinorAirfield = (a) => !a.icao && !a.iata;
