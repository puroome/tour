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

from shapely import set_precision, union_all
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon, shape

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
# 이웃한 읍·면·동을 따로 단순화하면 맞닿은 변이 어긋나 사이에 실틈이 남는다(서울 기준 면적의
# 3%). 각 폴리곤을 이만큼 부풀려 서로 겹치게 해서 메운다. 모서리를 각지게(mitre) 늘려야
# 둥근 이음매로 꼭짓점이 불어나지 않는다.
SEAM_CLOSE = float(os.environ.get("SEAM_CLOSE", 0.07))
# 신안군 앞바다처럼 섬이 수천 개인 곳은 바위 하나까지 담으면 용량 대부분을 섬이 차지한다.
# 읍·면·동은 실제로 갈 수 있는 곳이라 그대로 두고, 칠할 면과 경계선에서만 걷어낸다.
# 1제곱단위 ≈ 0.58㎢.
# 독도(동도 0.095㎢·서도 0.061㎢)가 시·군 칠에도 남도록 문턱을 그 아래로 잡았다.
MUNI_MIN_AREA = float(os.environ.get("MUNI_MIN_AREA", 0.09))
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


def shrink(geometry, tolerance):
    """조각별로 단순화한다. 본체에서 떨어진 작은 섬은 강도를 낮춰 원형을 지킨다.

    독도(약 0.19㎢)처럼 작은 섬을 본체와 같은 강도로 줄이면 삼각형만 남고 면적이 사라져,
    시·군을 칠할 때 티끌로 걸러진다. 도심의 작은 동까지 같이 걸리지 않도록, 한 지역에서
    가장 큰 조각(본체)은 언제나 기본 강도로 줄인다.
    """
    parts = [p for p in getattr(geometry, "geoms", [geometry]) if not p.is_empty]
    if not parts:
        return geometry
    main = max(parts, key=lambda p: p.area)
    polygons = []
    for polygon in parts:
        scale = 1.0 if polygon is main or polygon.area >= 20 else max(.05, polygon.area / 20)
        small = polygon.simplify(tolerance * scale)
        if small.is_empty or not small.is_valid:
            small = polygon
        polygons.extend(p for p in getattr(small, "geoms", [small]) if not p.is_empty)
    if not polygons:
        return geometry
    return polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)


def drop_specks(geometry, min_area, min_hole=HOLE_MIN_AREA):
    """작은 섬과 구멍을 걷어낸다. 가장 큰 조각은 아무리 작아도 남긴다.

    구멍은 섬보다 훨씬 크게 잘라낸다. 읍·면·동을 따로 단순화한 탓에 이웃 사이에 남은 실틈이
    시·군을 합칠 때 구멍으로 굳는데, 그대로 두면 서울 한복판에 바탕색이 비친다. 완주군 안의
    전주시처럼 진짜로 둘러싼 구멍은 이 문턱보다 훨씬 넓어서 그대로 남는다.
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


def main():
    with io.open(SOURCE, encoding="utf-8") as fp:
        source = json.load(fp)

    by_muni = defaultdict(list)
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
        by_muni[key].append((props["adm_cd"], props["adm_nm"].split()[-1], moved))

    print("행정동 %d개 / 시·군 %d개" % (sum(len(v) for v in by_muni.values()), len(by_muni)))

    # 읍·면·동을 먼저 단순화하고, 그것들을 합쳐 시·군 외곽선을 만든다. 시·군을 따로 단순화하면
    # 읍·면·동이 시·군 밖으로 삐져나오는데, 이렇게 하면 그런 일이 생기지 않는다.
    dongs = {}
    munis = {}
    for key, items in by_muni.items():
        placed = []
        dongs[key] = []
        for code, name, geometry in sorted(items):
            small = shrink(geometry, DONG_TOLERANCE)
            if not small.is_valid:
                small = small.buffer(0)
            if small.is_empty:
                small = geometry
            if SEAM_CLOSE:
                small = small.buffer(SEAM_CLOSE, join_style="mitre", mitre_limit=2.0)
                # 부풀린 만큼 이웃과 겹치는데, 겹친 채로 두면 폴리곤마다 제 테두리를 그려서
                # 경계가 두 줄로 보인다. 앞서 자리를 잡은 이웃과 겹치는 부분을 잘라내면
                # 서로 같은 변을 공유하게 되어 선이 한 줄로 겹쳐 그려진다.
                overlaps = [other for other in placed if small.intersects(other)]
                if overlaps:
                    trimmed = small.difference(union_all(overlaps, grid_size=GRID), grid_size=GRID)
                    if not trimmed.is_empty and trimmed.geom_type in ("Polygon", "MultiPolygon"):
                        small = trimmed if trimmed.is_valid else trimmed.buffer(0)
            snapped = set_precision(small, GRID)
            if not snapped.is_empty and snapped.geom_type in ("Polygon", "MultiPolygon"):
                small = snapped
            placed.append(small)
            dongs[key].append((code, name, small))
        # 읍·면·동을 합친 그대로 둔다. 여기서 한 번 더 단순화하면 시·군 선이 읍·면·동
        # 가장자리에서 비껴나, 확대했을 때 바깥 경계가 두 줄로 보인다.
        munis[key] = set_precision(drop_specks(merge(placed), MUNI_MIN_AREA), GRID)

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
        for code, name, geometry in sorted(dongs[key]):
            path = to_path(shift(geometry))
            dong_vertices += vertex_count(path)
            payload[code] = {"n": name, "d": path}
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
