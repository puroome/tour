"""행정동 경계 하나로 시·군 백지도(js/map-data.json)와 읍·면·동 경계(js/dong/*.json)를
함께 만든다.

원본은 통계청 SGIS 기반의 행정동 경계다. 아래 파일을 이 스크립트 옆에 hjd.geojson 이라는
이름으로 내려받은 뒤 실행한다(분기마다 새 판이 올라오므로 ver 폴더를 최신으로 바꾼다).

  https://raw.githubusercontent.com/vuski/admdongkor/master/ver20260701/HangJeongDong_ver20260701.geojson
  출처: vuski/admdongkor (CC BY 4.0), 통계청 SGIS 행정동 경계

시·군 경계는 별도 자료를 받지 않고 행정동을 합쳐서 만든다. 두 단계가 같은 좌표에서 나오므로
경계가 어긋날 일이 없고, 어느 읍·면·동이 어느 시·군에 속하는지도 행정코드로 곧바로 정해진다.

필요한 것: python 3, shapely (pip install shapely). 앱에는 들어가지 않고 이 스크립트만 쓴다.
"""
import io
import json
import math
import os
import re
from collections import defaultdict

from shapely import coverage_invalid_edges, coverage_simplify, set_precision, union_all
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.strtree import STRtree

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)
SOURCE = os.path.join(TOOLS, "hjd.geojson")

# 람베르트 정각원뿔도법. 대한민국 지도가 흔히 쓰는 투영이고, 각을 보존해서 해안선 모양이
# 자연스럽게 나온다. js/core.js 의 projectCoordinatesToMap 이 같은 식을 쓴다.
LCC = {"lat1": 34.0, "lat2": 38.0, "lat0": 36.0, "lon0": 127.5}
# 위경도를 화면 좌표로 옮기는 배율. 예전 백지도와 같은 크기(세로 800 안팎)가 나오게 잡았다.
# app.js 의 점 크기·여백 상수가 그 눈금에 맞춰 손으로 조정된 값이라 그대로 두는 편이 낫다.
SCALE = 8230.0

# 경계를 얼마나 단순화할지(지도 좌표 단위, 1단위 ≈ 760m). 이 앱은 "이 근처에 갈 곳이
# 있구나"를 보여주는 용도라 실측 수준까지 갈 필요가 없다. 시·군 외곽선은 읍·면·동을 합쳐서
# 만들기 때문에 읍·면·동보다 더 거칠게 잡으면 읍·면·동이 시·군 밖으로 삐져나온다.
DONG_TOLERANCE = float(os.environ.get("DONG_TOLERANCE", 0.22))
# 시·군과 도(道) 경계선은 읍·면·동을 합친 결과를 그대로 쓴다. 조금이라도 더 단순화하면
# 읍·면·동 가장자리에서 비껴나, 확대했을 때 경계가 두 줄로 보인다.
# 저장할 때 쓰는 소수점 자릿수와, 그에 맞춘 격자. 좌표를 미리 이 격자에 맞춰 두면 파일에
# 적는 순간 값이 달라지지 않아, 맞닿은 두 폴리곤이 정확히 같은 변을 공유한다. 그래야 경계가
# 한 줄로 그려진다. 1자리 = 0.1단위 ≈ 76m.
DECIMALS = 1
GRID = 10 ** -DECIMALS
# 바다로 둘러싸여 어느 이웃과도 변을 맞대지 않는 조각은 덮개에서 떼어내 따로 줄인다(shrink).
# coverage_simplify 는 덮개 전체에 같은 강도를 걸어서, 독도(0.16·0.11제곱단위)처럼 작은
# 섬을 절반 아래로 깎아 시·군 칠에서 티끌로 걸러지게 만든다. 떼어낸 섬은 공유하는 변이
# 없으므로 따로 줄여도 경계가 어긋날 일이 없다. 이보다 큰 조각은 그냥 덮개에 둔다.
ISLAND_MAX_AREA = float(os.environ.get("ISLAND_MAX_AREA", 20.0))
# 신안군 앞바다처럼 섬이 수천 개인 곳은 바위 하나까지 담으면 용량 대부분을 섬이 차지한다.
# 읍·면·동은 실제로 갈 수 있는 곳이라 그대로 두고, 칠할 면과 경계선에서만 걷어낸다.
# 1제곱단위 ≈ 0.58㎢.
# 독도(동도 0.095㎢·서도 0.061㎢)가 시·군 칠에도 남도록 문턱을 그 아래로 잡았다. 단순화를
# 거치고 나면 동도 0.155·서도 0.095제곱단위라 여유가 얼마 없다. 문턱을 0.09까지 올리면
# 서도가 5% 차이로 겨우 살아남고, 강도를 조금만 건드려도 사라진다. 0.06이면 그 걱정이 없고
# 섬이 시·군 칠에도 남아 읍·면·동만 덩그러니 뜨는 자리가 줄어든다. 값은 12KB 남짓이다.
MUNI_MIN_AREA = float(os.environ.get("MUNI_MIN_AREA", 0.06))
PROVINCE_MIN_AREA = float(os.environ.get("PROVINCE_MIN_AREA", 6.0))
# 구멍을 지우는 문턱. 가장 작은 시·군인 과천시(35.9㎢ ≈ 62제곱단위)보다 훨씬 작게 잡아,
# 진짜 둘러싸인 지역은 남기고 단순화가 남긴 실틈만 메운다.
HOLE_MIN_AREA = float(os.environ.get("HOLE_MIN_AREA", 12.0))

METRO = {
    "11": "서울특별시", "26": "부산광역시", "27": "대구광역시", "28": "인천광역시",
    "30": "대전광역시", "31": "울산광역시", "36": "세종특별자치시"
}
# 2026년 기준 광주광역시와 전라남도는 전남광주통합특별시(코드 12)로 합쳐져 있다. 시트의
# 지역ID와 구글드라이브 사진 폴더가 기존 시·군 이름에 묶여 있으므로, 지도 키는 예전처럼
# 광주 자치구를 "광주광역시" 하나로 되돌려 쓴다.
MERGED_METRO_SIDO = "12"
MERGED_METRO_NAME = "광주광역시"
# 같은 이름의 군이 두 도에 있어 지도 키에 도 이름을 붙여 구분한다.
AMBIGUOUS = {"고성군": {"강원특별자치도": "고성군(강원)", "경상남도": "고성군(경남)"}}
# 광역시는 자치구·군 하나하나가 시·군만 한 크기라, 읍·면·동만 보여주면 어디인지 알기 어렵다
# ("서울특별시 한남동"). 그래서 광역시에 한해 자치구 이름을 함께 담는다. 도(道) 안의
# 창원시·수원시 같은 곳은 시 이름만으로 충분해서 담지 않는다.
DISTRICT_KEYS = set(METRO.values()) | {MERGED_METRO_NAME}


def project(lon, lat):
    """위경도 -> 지도 좌표(y는 화면과 같이 아래로 증가)."""
    lat1 = math.radians(LCC["lat1"])
    lat2 = math.radians(LCC["lat2"])
    lat0 = math.radians(LCC["lat0"])
    phi = math.radians(lat)
    n = (math.log(math.cos(lat1) / math.cos(lat2))
         / math.log(math.tan(math.pi / 4 + lat2 / 2) / math.tan(math.pi / 4 + lat1 / 2)))
    f = math.cos(lat1) * math.tan(math.pi / 4 + lat1 / 2) ** n / n
    rho = f / math.tan(math.pi / 4 + phi / 2) ** n
    rho0 = f / math.tan(math.pi / 4 + lat0 / 2) ** n
    theta = n * math.radians(lon - LCC["lon0"])
    # 화면 좌표는 아래로 갈수록 y가 커지므로, 북쪽이 위로 오도록 남북을 뒤집는다.
    return (SCALE * rho * math.sin(theta), SCALE * (rho * math.cos(theta) - rho0))


def muni_key(props):
    """행정동 속성 -> 지도에서 쓰는 시·군 이름."""
    sido = props["sido"]
    name = props["sggnm"]
    if sido in METRO:
        return METRO[sido]
    if sido == MERGED_METRO_SIDO and name.endswith("구"):
        return MERGED_METRO_NAME
    matched = re.match(r"^(.+?[시군])", name)
    key = matched.group(1) if matched else name
    return AMBIGUOUS.get(key, {}).get(province_of(props), key)


def district_of(props, key):
    """읍·면·동과 함께 담을 자치구·군 이름. 담지 않을 곳은 빈 문자열.

    세종특별자치시는 자치구가 없는데도 원본이 sggnm 을 "세종시"로 채워 둬서, 그대로 쓰면
    "세종특별자치시 세종시 조치원읍"이 된다. 구·군으로 끝나는 것만 받아 걸러낸다.
    """
    name = props["sggnm"]
    if key in DISTRICT_KEYS and name.endswith(("구", "군")):
        return name
    return ""


def province_of(props):
    """지도에 표시할 도(道) 이름. 통합 전 이름을 그대로 쓴다."""
    sido = props["sido"]
    if sido in METRO:
        return METRO[sido]
    if sido == MERGED_METRO_SIDO:
        return MERGED_METRO_NAME if props["sggnm"].endswith("구") else "전라남도"
    return props["sidonm"]


def to_path(geometry, decimals=DECIMALS):
    """shapely 폴리곤 -> SVG path. 구멍(내부 링)도 함께 담는다."""
    polygons = getattr(geometry, "geoms", [geometry])
    parts = []
    for polygon in polygons:
        if polygon.is_empty:
            continue
        for ring in [polygon.exterior] + list(polygon.interiors):
            points = []
            for x, y in ring.coords:
                point = (round(x, decimals), round(y, decimals))
                if not points or points[-1] != point:
                    points.append(point)
            if len(points) >= 3:
                parts.append("M" + "L".join(f"{x:.{decimals}f} {y:.{decimals}f}" for x, y in points) + "Z")
    return "".join(parts)


def vertex_count(path):
    return len(re.findall(r"-?\d+\.\d+", path)) // 2


def shrink_islands(polygons, tolerance):
    """떼어낸 섬을 조각 크기에 맞춰 단순화한다.

    독도(약 0.19㎢)처럼 작은 섬을 본체와 같은 강도로 줄이면 삼각형만 남고 면적이 사라져,
    시·군을 칠할 때 티끌로 걸러진다. 작을수록 강도를 낮춰 원형을 지킨다. 이 조각들은 어느
    이웃과도 변을 맞대지 않으므로(split_islands 참고) 따로 줄여도 경계가 어긋나지 않는다.
    """
    kept = []
    for polygon in polygons:
        scale = max(.05, min(1.0, polygon.area / ISLAND_MAX_AREA))
        small = polygon.simplify(tolerance * scale)
        if small.is_empty or not small.is_valid:
            small = polygon
        kept.extend(parts(small))
    return kept


def drop_specks(geometry, min_area, min_hole=HOLE_MIN_AREA):
    """작은 섬과 구멍을 걷어낸다. 가장 큰 조각은 아무리 작아도 남긴다.

    구멍은 섬보다 훨씬 크게 잘라낸다. 원본에서 변이 맞물리지 않는 자리(heal_overlaps 참고)와
    새만금처럼 어느 행정동에도 안 들어간 땅이 시·군을 합칠 때 구멍으로 남는데, 그대로 두면
    지도 한복판에 바탕색이 비친다. 완주군 안의 전주시처럼 진짜로 둘러싼 구멍은 이 문턱보다
    훨씬 넓어서 그대로 남는다.
    """
    polygons = [p for p in getattr(geometry, "geoms", [geometry]) if not p.is_empty]
    if not polygons:
        return geometry
    kept = [p for p in polygons if p.area >= min_area] or [max(polygons, key=lambda p: p.area)]
    trimmed = [Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area >= min_hole]) for p in kept]
    return trimmed[0] if len(trimmed) == 1 else MultiPolygon(trimmed)


def merge(geometries):
    """폴리곤을 한 덩어리로 합친다. 격자 맞춤이 미세한 어긋남을 흡수한다."""
    united = union_all(geometries, grid_size=GRID)
    return united if united.is_valid else united.buffer(0)


def parts(geometry):
    return [p for p in getattr(geometry, "geoms", [geometry]) if not p.is_empty and p.area > 0]


def rebuild(polygons, fallback):
    if not polygons:
        return fallback
    return polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)


def heal_overlaps(geometries):
    """원본에서 서로 겹치는 읍·면·동을 정리한다.

    coverage_simplify 는 입력이 빈틈도 겹침도 없는 덮개라고 믿고 동작한다. 통계청 원본은
    전국에서 서른 개 남짓만 국지적으로 어긋나 있는데, 그 자리만 뒤엣것에서 앞엣것을 빼서
    맞춰 둔다. 전부 훑으면 오래 걸리므로 어긋난다고 지목된 것들끼리만 본다.
    """
    flagged = [i for i, edge in enumerate(coverage_invalid_edges(geometries, gap_width=0.0))
               if edge is not None and not edge.is_empty]
    if not flagged:
        return geometries, 0
    healed = list(geometries)
    for position, index in enumerate(flagged):
        earlier = [healed[j] for j in flagged[:position] if healed[j].intersects(healed[index])]
        if not earlier:
            continue
        trimmed = healed[index].difference(union_all(earlier))
        if not trimmed.is_empty and trimmed.geom_type in ("Polygon", "MultiPolygon"):
            healed[index] = trimmed if trimmed.is_valid else trimmed.buffer(0)
    return healed, len(flagged)


def split_islands(geometries):
    """어느 이웃과도 맞닿지 않는 작은 조각을 덮개에서 떼어낸다.

    떼어낸 조각과, 그것을 뺀 나머지를 함께 돌려준다. 나머지가 통째로 비는 읍·면·동
    (백령면처럼 섬만으로 이뤄진 곳)도 있어서, 덮개에 넣을 때는 빈 자리를 건너뛴다.
    """
    tree = STRtree(geometries)
    mainland, islands = [], []
    for index, geometry in enumerate(geometries):
        keep, apart = [], []
        for piece in parts(geometry):
            if piece.area >= ISLAND_MAX_AREA:
                keep.append(piece)
                continue
            touching = [j for j in tree.query(piece) if j != index and geometries[j].intersects(piece)]
            (apart if not touching else keep).append(piece)
        mainland.append(rebuild(keep, None))
        islands.append(apart)
    return mainland, islands


def main():
    with io.open(SOURCE, encoding="utf-8") as fp:
        source = json.load(fp)

    entries = []
    provinces = {}
    for feature in source["features"]:
        props = feature["properties"]
        geometry = shape(feature["geometry"])
        polygons = []
        for polygon in (geometry.geoms if geometry.geom_type == "MultiPolygon" else [geometry]):
            shell = [project(x, y) for x, y in polygon.exterior.coords]
            holes = [[project(x, y) for x, y in hole.coords] for hole in polygon.interiors]
            polygons.append(Polygon(shell, holes))
        moved = MultiPolygon(polygons) if len(polygons) > 1 else polygons[0]
        if not moved.is_valid:
            moved = moved.buffer(0)
        key = muni_key(props)
        provinces[key] = province_of(props)
        entries.append((key, props["adm_cd"], props["adm_nm"].split()[-1], district_of(props, key), moved))

    entries.sort(key=lambda row: (row[0], row[1]))
    print("행정동 %d개 / 시·군 %d개" % (len(entries), len(provinces)))

    # 전국 읍·면·동을 한 벌의 덮개로 보고 한꺼번에 줄인다. coverage_simplify 는 맞닿은 변을
    # 양쪽이 똑같이 공유한 채로 줄여서, 이웃 사이에 실틈도 겹침도 남기지 않는다. 폴리곤마다
    # 따로 줄인 뒤 부풀려 메우던 예전 방식은 시·군 경계 바깥으로도 부풀어서, 이웃 시·군과
    # 0.14단위(약 108m)씩 겹쳐 확대하면 경계가 두 줄로 보였다.
    shapes = [row[4] for row in entries]
    shapes, flagged = heal_overlaps(shapes)
    # 겹침은 위에서 잘라냈지만, 한쪽에만 꼭짓점이 있어 변이 맞물리지 않는 자리는 남는다.
    # 그런 곳은 이웃과 공유하는 변이 아니라 각자의 바깥 경계로 취급돼 수십 미터짜리 틈이
    # 생긴다. 전국에서 몇 자리뿐이라 그대로 두고, 몇 개나 남았는지만 적어 둔다.
    left = sum(1 for edge in coverage_invalid_edges(shapes, gap_width=0.0)
               if edge is not None and not edge.is_empty)
    print("원본에서 어긋난 읍·면·동 %d개 중 %d개 정리, %d개는 변이 맞물리지 않아 남김"
          % (flagged, flagged - left, left))

    mainland, islands = split_islands(shapes)
    filled = [index for index, geometry in enumerate(mainland) if geometry is not None]
    simplified = list(coverage_simplify([mainland[i] for i in filled], DONG_TOLERANCE,
                                        simplify_boundary=True))
    reduced = [None] * len(mainland)
    for position, index in enumerate(filled):
        reduced[index] = simplified[position]
    print("떼어낸 섬 %d개 / 덮개에 넣은 읍·면·동 %d개"
          % (sum(len(v) for v in islands), len(filled)))

    dongs = defaultdict(list)
    munis = {}
    for index, (key, code, name, district, original) in enumerate(entries):
        # 떼어낸 섬은 조각 크기에 맞춰 따로 줄인다. 이 강도까지 덮개에 걸면 독도가 사라진다.
        pieces = shrink_islands(islands[index], DONG_TOLERANCE)
        pieces.extend(parts(reduced[index]) if reduced[index] is not None else [])
        small = rebuild(pieces, original)
        if not small.is_valid:
            small = small.buffer(0)
        snapped = set_precision(small, GRID)
        if not snapped.is_empty and snapped.geom_type in ("Polygon", "MultiPolygon"):
            small = snapped
        dongs[key].append((code, name, district, small))

    for key, items in dongs.items():
        # 읍·면·동을 합친 그대로 둔다. 여기서 한 번 더 단순화하면 시·군 선이 읍·면·동
        # 가장자리에서 비껴나, 확대했을 때 바깥 경계가 두 줄로 보인다.
        munis[key] = set_precision(drop_specks(merge([row[-1] for row in items]), MUNI_MIN_AREA), GRID)

    old_path = os.path.join(REPO, "js", "map-data.json")
    old = json.load(io.open(old_path, encoding="utf-8")) if os.path.exists(old_path) else {"MUNIS": {}, "PROVINCES": {}}
    missing = sorted(set(old["MUNIS"]) - set(munis))
    added = sorted(set(munis) - set(old["MUNIS"]))
    print("기존에만 있던 시·군:", missing)
    print("새로 생긴 시·군:", added)

    bounds = merge(list(munis.values())).bounds
    offset_x = -bounds[0] + 8
    offset_y = -bounds[1] + 8
    width = round(bounds[2] - bounds[0] + 16, 1)
    height = round(bounds[3] - bounds[1] + 16, 1)

    def shift(geometry):
        return translate(geometry, offset_x, offset_y)

    muni_out = {}
    for key, geometry in munis.items():
        entry = {"d": to_path(shift(geometry)), "prov": provinces[key]}
        previous = old["MUNIS"].get(key, {})
        for carried in ("region", "pop"):
            if carried in previous:
                entry[carried] = previous[carried]
        centre = shift(geometry).representative_point()
        entry["cx"] = round(centre.x, 1)
        entry["cy"] = round(centre.y, 1)
        muni_out[key] = entry

    province_out = {}
    for province in sorted(set(provinces.values())):
        members = [munis[k] for k, p in provinces.items() if p == province]
        outline = set_precision(drop_specks(merge(members), PROVINCE_MIN_AREA), GRID)
        entry = {"d": to_path(shift(outline))}
        if province in old.get("PROVINCES", {}) and "region" in old["PROVINCES"][province]:
            entry["region"] = old["PROVINCES"][province]["region"]
        province_out[province] = entry

    out_dir = os.path.join(REPO, "js", "dong")
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    for stale in os.listdir(out_dir):
        if stale.endswith(".json"):
            os.remove(os.path.join(out_dir, stale))

    chunks = {}
    dong_vertices = 0
    for index, key in enumerate(sorted(dongs), start=1):
        chunks[key] = index
        payload = {}
        for code, name, district, geometry in sorted(dongs[key]):
            path = to_path(shift(geometry))
            dong_vertices += vertex_count(path)
            payload[code] = {"n": name, "d": path}
            if district:
                payload[code]["g"] = district
        with io.open(os.path.join(out_dir, "%d.json" % index), "w", encoding="utf-8") as fp:
            json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))

    data = {
        "MAP_W": width, "MAP_H": height,
        "PROVINCES": province_out, "MUNIS": muni_out, "DONG_CHUNKS": chunks
    }
    with io.open(old_path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(",", ":"))

    meta = {"MUNIS": {k: {x: y for x, y in v.items() if x != "d"} for k, v in muni_out.items()}}
    with io.open(os.path.join(REPO, "js", "map-region-meta.json"), "w", encoding="utf-8") as fp:
        json.dump(meta, fp, ensure_ascii=False, separators=(",", ":"))

    # 관리자 화면은 모듈이 아니라 <script> 한 줄로 지역 이름표만 읽어 간다. 경계 좌표는 쓰지
    # 않으므로 가벼운 메타데이터만 담는다.
    with io.open(os.path.join(REPO, "js", "map-data.js"), "w", encoding="utf-8") as fp:
        fp.write("// tools/build_map.py 가 만든 파일. 직접 고치지 말 것.\n")
        fp.write("window.KOREA_MAP_DATA = ")
        json.dump(meta, fp, ensure_ascii=False, separators=(",", ":"))
        fp.write(";\n")

    total = sum(len(v) for v in dongs.values())
    muni_vertices = sum(vertex_count(v["d"]) for v in muni_out.values())
    print("캔버스 %.1f x %.1f" % (width, height))
    print("js/core.js 의 MAP_PROJECTION 에 넣을 값: scale=%.1f offsetX=%.6f offsetY=%.6f"
          % (SCALE, offset_x, offset_y))
    print("읍·면·동 %d개 / 꼭짓점 %d개 / 평균 %.1f" % (total, dong_vertices, dong_vertices / total))
    print("시·군 %d개 / 꼭짓점 %d개 / 평균 %.1f" % (len(muni_out), muni_vertices, muni_vertices / len(muni_out)))
    print("도 경계 %d개 / 꼭짓점 %d개" % (len(province_out), sum(vertex_count(v["d"]) for v in province_out.values())))
    sizes = sorted(((os.path.getsize(os.path.join(out_dir, "%d.json" % i)), k) for k, i in chunks.items()), reverse=True)
    print("가장 큰 청크:", [(k, "%dKB" % round(s / 1024)) for s, k in sizes[:6]])
    print("읍·면·동 합계 %dKB / map-data.json %dKB"
          % (sum(s for s, _ in sizes) / 1024, os.path.getsize(old_path) / 1024))


if __name__ == "__main__":
    main()
