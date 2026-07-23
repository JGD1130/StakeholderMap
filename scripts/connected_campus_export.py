# -*- coding: utf-8 -*-
"""
Mapfluence Connected Campus Floorplan Export

Use this exporter from a building-specific floor plan view inside a connected-campus
Revit model. It exports only that building's Rooms / Doors / Stairs for the matching
building views across floors and intentionally skips DXF / Overall / Axon processing.

This keeps the standard single-building exporter untouched and avoids Revit failure
mode caused by whole-model DXF export on connected Cherokee-style campus models.
"""

import os, json, re, math, codecs
import clr

uidoc = __revit__.ActiveUIDocument
doc = uidoc.Document
view = doc.ActiveView

clr.AddReference("System")
clr.AddReference("System.Windows.Forms")
from System.Windows.Forms import FolderBrowserDialog, DialogResult

clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')
from Autodesk.Revit.UI import TaskDialog

from Autodesk.Revit.DB import (
    FilteredElementCollector, BuiltInCategory, BuiltInParameter,
    SpatialElementBoundaryOptions, SpatialElementBoundaryLocation,
    ViewPlan, ViewType, Phase, StorageType, XYZ
)

TARGET_PHASE_NAMES = ["Existing", "New Construction"]
RESTRICT_TO_PHASE = True
ALLOWED_LEVELS = [
    "BASEMENT",
    "LEVEL 1",
    "LEVEL 2",
    "LEVEL 3",
    "LEVEL 4",
    "LEVEL 5",
]
FILENAME_MAP = {
    "BASEMENT": "BASEMENT_Dept",
    "LEVEL 1": "LEVEL_1_Dept",
    "LEVEL 2": "LEVEL_2_Dept",
    "LEVEL 3": "LEVEL_3_Dept",
    "LEVEL 4": "LEVEL_4_Dept",
    "LEVEL 5": "LEVEL_5_Dept",
}
EXCLUDED_VIEW_KEYWORDS = ["overall", "axon", "area", "working", "demo", "furniture"]
VIEW_CROP_BBOX_PAD_FEET = 5.0
FEET_PER_DEGREE_LAT = 364000.0

if not isinstance(view, ViewPlan):
    TaskDialog.Show("Connected Campus Export", "Switch to a building Floor Plan view first.")
    raise SystemExit


def sanitize(name):
    return re.sub(r'[^A-Za-z0-9_\-]+', "_", (name or "").strip())


def canon(s):
    return re.sub(r'[^a-z0-9]+', '', (s or '').lower())


def element_id_to_int(eid):
    if eid is None:
        return -1
    try:
        return int(eid.IntegerValue)
    except:
        pass
    try:
        return int(eid.Value)
    except:
        pass
    try:
        return int(str(eid))
    except:
        return -1


def get_phase_by_name(doc, name):
    for p in FilteredElementCollector(doc).OfClass(Phase):
        if p.Name.strip().lower() == name.strip().lower():
            return p
    return None


def get_str_param(elem, bip=None, alt=None):
    try:
        if bip:
            p = elem.get_Parameter(bip)
            if p and p.AsString():
                return p.AsString()
        if alt:
            p = elem.LookupParameter(alt)
            if p and p.AsString():
                return p.AsString()
    except:
        pass
    return ""


def get_param_any(elem, pname):
    p = elem.LookupParameter(pname)
    if not p:
        try:
            et = doc.GetElement(elem.GetTypeId())
            if et:
                p = et.LookupParameter(pname)
        except:
            return ""
    if not p:
        return ""
    try:
        if p.StorageType == StorageType.String:
            return p.AsString() or ""
        if p.StorageType == StorageType.Integer:
            return str(p.AsInteger())
        if p.StorageType == StorageType.Double:
            return str(p.AsDouble())
        if p.StorageType == StorageType.ElementId:
            eid = p.AsElementId()
            ref = doc.GetElement(eid)
            return ref.Name if ref else ""
    except:
        pass
    return ""


def get_param_value(p):
    try:
        if p.StorageType == StorageType.String:
            return p.AsString() or ""
        if p.StorageType == StorageType.Integer:
            return str(p.AsInteger())
        if p.StorageType == StorageType.Double:
            return str(p.AsDouble())
        if p.StorageType == StorageType.ElementId:
            eid = p.AsElementId()
            ref = doc.GetElement(eid)
            return ref.Name if ref else ""
    except:
        pass
    return ""


def get_param_by_name(elem, pname):
    params = elem.GetParameters(pname)
    if params:
        return get_param_value(params[0])
    return ""


def ring_from_loop(loop):
    pts = []
    for seg in loop:
        c = seg.GetCurve()
        if not c:
            continue
        p = c.GetEndPoint(0)
        pts.append([p.X, p.Y])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def get_type_info(elem):
    type_name = ""
    family_name = ""
    try:
        et = doc.GetElement(elem.GetTypeId())
        if et:
            type_name = getattr(et, "Name", "") or ""
            family_name = getattr(et, "FamilyName", "") or ""
    except:
        pass
    return family_name, type_name


def bearing_from_vector(dx, dy):
    try:
        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            return None
        return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0
    except:
        return None


def element_bearing(elem):
    try:
        facing = getattr(elem, "FacingOrientation", None)
        if facing:
            bearing = bearing_from_vector(facing.X, facing.Y)
            if bearing is not None:
                return bearing
    except:
        pass
    try:
        loc = getattr(elem, "Location", None)
        curve = getattr(loc, "Curve", None)
        if curve:
            p0 = curve.GetEndPoint(0)
            p1 = curve.GetEndPoint(1)
            bearing = bearing_from_vector(p1.X - p0.X, p1.Y - p0.Y)
            if bearing is not None:
                return bearing
    except:
        pass
    return None


def element_local_point(elem, view_ref=None):
    try:
        loc = getattr(elem, "Location", None)
        pt = getattr(loc, "Point", None)
        if pt:
            return ft_to_local(pt.X, pt.Y)
    except:
        pass
    try:
        loc = getattr(elem, "Location", None)
        curve = getattr(loc, "Curve", None)
        if curve:
            pt = curve.Evaluate(0.5, True)
            return ft_to_local(pt.X, pt.Y)
    except:
        pass
    try:
        bbox = elem.get_BoundingBox(view_ref) or elem.get_BoundingBox(None)
        if bbox:
            return ft_to_local((bbox.Min.X + bbox.Max.X) / 2.0, (bbox.Min.Y + bbox.Max.Y) / 2.0)
    except:
        pass
    return None


def _iter_geom_points_from_coords(node):
    if node is None:
        return
    if isinstance(node, (list, tuple)):
        if len(node) >= 2 and isinstance(node[0], (int, long, float)) and isinstance(node[1], (int, long, float)):
            yield [float(node[0]), float(node[1])]
            return
        for child in node:
            for pt in _iter_geom_points_from_coords(child):
                yield pt


def geometry_bounds(geom):
    if not geom:
        return None
    pts = []
    gtype = geom.get("type")
    if gtype == "GeometryCollection":
        for child in geom.get("geometries", []) or []:
            child_bounds = geometry_bounds(child)
            if child_bounds:
                pts.extend([
                    [child_bounds["min_x"], child_bounds["min_y"]],
                    [child_bounds["max_x"], child_bounds["max_y"]],
                ])
    else:
        for pt in _iter_geom_points_from_coords(geom.get("coordinates")):
            pts.append(pt)
    if not pts:
        return None
    xs = [pt[0] for pt in pts]
    ys = [pt[1] for pt in pts]
    return {
        "min_x": min(xs),
        "min_y": min(ys),
        "max_x": max(xs),
        "max_y": max(ys),
    }


def expand_bounds(bounds, pad):
    if not bounds:
        return None
    return {
        "min_x": bounds["min_x"] - pad,
        "min_y": bounds["min_y"] - pad,
        "max_x": bounds["max_x"] + pad,
        "max_y": bounds["max_y"] + pad,
    }


def bounds_intersect(a, b):
    if not a or not b:
        return False
    return not (
        a["max_x"] < b["min_x"] or
        a["min_x"] > b["max_x"] or
        a["max_y"] < b["min_y"] or
        a["min_y"] > b["max_y"]
    )


def write_feature_collection(path, title, features):
    fc = {"type": "FeatureCollection", "name": title, "features": features}
    with codecs.open(path, "w", "utf-8") as f:
        json.dump(fc, f, indent=2)


def extract_level_name(name):
    up = (name or "").upper()
    if "BASEMENT" in up:
        return "BASEMENT"
    m = re.search(r'LEVEL\s*([0-9]+)', up)
    if m:
        return "LEVEL %s" % m.group(1)
    return ""


def extract_building_token(name):
    name = name or ""
    level_name = extract_level_name(name)
    if not level_name:
        return ""
    up = name.upper()
    idx = up.find(level_name)
    prefix = name[:idx] if idx >= 0 else name
    prefix = re.sub(r'^\s*\d+\s*[_\-]\s*', '', prefix)
    prefix = re.sub(r'\bAXON\b', '', prefix, flags=re.I)
    prefix = re.sub(r'\bOVERALL\b', '', prefix, flags=re.I)
    prefix = prefix.strip(' _-')
    if prefix.endswith('-'):
        prefix = prefix[:-1].strip()
    return prefix


def is_excluded_view(name):
    low = (name or '').lower()
    for kw in EXCLUDED_VIEW_KEYWORDS:
        if kw in low:
            return True
    return False


def is_better_view(new_view, current_view):
    new_name = new_view.Name or ''
    cur_name = current_view.Name or ''
    active_id = element_id_to_int(view.Id) if view else -1
    new_id = element_id_to_int(new_view.Id)
    cur_id = element_id_to_int(current_view.Id)
    if new_id == active_id:
        return True
    if cur_id == active_id:
        return False
    new_copy = '(copy)' in new_name.lower()
    cur_copy = '(copy)' in cur_name.lower()
    if new_copy != cur_copy:
        return not new_copy
    return len(new_name) < len(cur_name)


site_location = doc.SiteLocation
base_lat_rad = site_location.Latitude
base_lon_rad = site_location.Longitude
project_position = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero)
project_angle = project_position.Angle
project_east = project_position.EastWest
project_north = project_position.NorthSouth
_cos_base_lat = math.cos(base_lat_rad)
_feet_per_degree_lon = FEET_PER_DEGREE_LAT * _cos_base_lat if abs(_cos_base_lat) > 1e-9 else FEET_PER_DEGREE_LAT


def ft_to_local(x, y):
    cos_a = math.cos(project_angle)
    sin_a = math.sin(project_angle)
    rx = x * cos_a - y * sin_a
    ry = x * sin_a + y * cos_a
    east = rx + project_east
    north = ry + project_north
    lon = math.degrees(base_lon_rad) + (east / _feet_per_degree_lon)
    lat = math.degrees(base_lat_rad) + (north / FEET_PER_DEGREE_LAT)
    return [lon, lat]


def ring_ft_to_local(ring):
    return [ft_to_local(x, y) for x, y in ring]


def view_crop_local_bounds(view_plan, pad=0.0):
    try:
        if not view_plan or not getattr(view_plan, 'CropBoxActive', False):
            return None
        crop = view_plan.CropBox
        if not crop:
            return None
        tf = getattr(crop, 'Transform', None)
        pts = []
        for x in [crop.Min.X, crop.Max.X]:
            for y in [crop.Min.Y, crop.Max.Y]:
                pt = XYZ(x, y, crop.Min.Z)
                if tf:
                    pt = tf.OfPoint(pt)
                pts.append(ft_to_local(pt.X, pt.Y))
        if not pts:
            return None
        bounds = {
            'min_x': min(pt[0] for pt in pts),
            'min_y': min(pt[1] for pt in pts),
            'max_x': max(pt[0] for pt in pts),
            'max_y': max(pt[1] for pt in pts),
        }
        return expand_bounds(bounds, pad) if pad else bounds
    except:
        return None


TARGET_PHASES = []
TARGET_PHASE_IDS = set()
if RESTRICT_TO_PHASE:
    for _pname in TARGET_PHASE_NAMES:
        _ph = get_phase_by_name(doc, _pname)
        if _ph:
            TARGET_PHASES.append(_ph)
            TARGET_PHASE_IDS.add(element_id_to_int(_ph.Id))
    if not TARGET_PHASES:
        TaskDialog.Show("Connected Campus Export", "None of these phases found:\n%s" % "\n".join(TARGET_PHASE_NAMES))
        raise SystemExit

active_view_name = view.Name or ''
if is_excluded_view(active_view_name):
    TaskDialog.Show(
        "Connected Campus Export",
        "Switch to a building floor plan view, not an Overall / Axon / Area view.\n\nCurrent view: %s" % active_view_name
    )
    raise SystemExit

selected_building = extract_building_token(active_view_name)
selected_level = extract_level_name(active_view_name)
if not selected_building or not selected_level:
    TaskDialog.Show(
        "Connected Campus Export",
        "Could not determine the building + level from the active view name.\n\nExpected something like:\n3_Main/Administration - LEVEL 1\n4_North A - BASEMENT"
    )
    raise SystemExit

selected_building_key = canon(selected_building)

views_by_level = {}
for v in FilteredElementCollector(doc).OfClass(ViewPlan):
    if v.ViewType != ViewType.FloorPlan or v.IsTemplate:
        continue
    name = v.Name or ''
    if is_excluded_view(name):
        continue
    phase_param = v.get_Parameter(BuiltInParameter.VIEW_PHASE)
    if not phase_param:
        continue
    phase = doc.GetElement(phase_param.AsElementId())
    if not phase or (RESTRICT_TO_PHASE and phase.Name not in TARGET_PHASE_NAMES):
        continue
    building_token = extract_building_token(name)
    if canon(building_token) != selected_building_key:
        continue
    level_name = extract_level_name(name)
    if not level_name or level_name not in ALLOWED_LEVELS:
        continue
    if level_name not in views_by_level or is_better_view(v, views_by_level[level_name]):
        views_by_level[level_name] = v

if not views_by_level:
    TaskDialog.Show(
        "Connected Campus Export",
        "No building-specific floor plan views were found for '%s'.\n\nOpen a building view like '3_Main/Administration - LEVEL 1' and try again." % selected_building
    )
    raise SystemExit

dlg = FolderBrowserDialog()
dlg.Description = "Choose output folder for %s" % selected_building
if dlg.ShowDialog() != DialogResult.OK:
    raise SystemExit
out_dir = dlg.SelectedPath
if not os.path.exists(out_dir):
    os.makedirs(out_dir)

doors_dir = os.path.join(out_dir, 'Doors')
stairs_dir = os.path.join(out_dir, 'Stairs')
for folder in [doors_dir, stairs_dir]:
    if not os.path.exists(folder):
        os.makedirs(folder)

TaskDialog.Show(
    "Connected Campus Export",
    "Building: %s\nFloors: %s\n\nThis connected-campus exporter skips DXF / Overall / Axon processing and exports Rooms / Doors / Stairs only." % (
        selected_building,
        ', '.join(sorted(views_by_level.keys()))
    )
)

sbo = SpatialElementBoundaryOptions()
sbo.SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.CoreCenter
by_level = {}
doors_written = []
stairs_written = []
summary_lines = []

for level_name in sorted(views_by_level.keys(), key=lambda x: (x != 'BASEMENT', x)):
    v = views_by_level[level_name]
    crop_bounds = view_crop_local_bounds(v, VIEW_CROP_BBOX_PAD_FEET)
    level_features = []
    room_seen = set()

    room_elems = FilteredElementCollector(doc, v.Id).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
    for r in room_elems:
        if RESTRICT_TO_PHASE:
            try:
                ph_param = r.get_Parameter(BuiltInParameter.ROOM_PHASE)
                if not ph_param or element_id_to_int(ph_param.AsElementId()) not in TARGET_PHASE_IDS:
                    continue
            except:
                continue
        try:
            if r.Area <= 0:
                continue
        except:
            continue
        rid = element_id_to_int(r.Id)
        if rid in room_seen:
            continue
        loops = r.GetBoundarySegments(sbo)
        if not loops:
            continue
        polys = []
        for loop in loops:
            ring = ring_from_loop(loop)
            if ring:
                polys.append([ring_ft_to_local(ring)])
        if not polys:
            continue
        geom = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
        if crop_bounds and not bounds_intersect(geometry_bounds(geom), crop_bounds):
            continue
        _occ_raw = get_param_by_name(r, "NCES_Occupancy Status") or get_param_any(r, "Occupancy Status")
        props = {
            "Element": "Room",
            "Building": selected_building,
            "Number": get_str_param(r, BuiltInParameter.ROOM_NUMBER),
            "Name": get_str_param(r, BuiltInParameter.ROOM_NAME),
            "NCES_Type": get_param_any(r, "NCES Types"),
            "NCES_Department": get_param_any(r, "NCES_Dept"),
            "NCES_Occupancy Status": _occ_raw,
            "occupancyStatus": _occ_raw if _occ_raw else "Occupied",
            "Workstations": get_param_any(r, "NCES_Workstations") or get_param_any(r, "Workstations"),
            "Seat Count": get_param_by_name(r, "NCES_Seat Count") or get_param_any(r, "Seat Count"),
            "Level": level_name,
            "Area_SF": round(r.Area, 2),
            "RevitId": rid,
            "Revit_UniqueId": r.UniqueId
        }
        level_features.append({"type": "Feature", "properties": props, "geometry": geom})
        room_seen.add(rid)

    if not level_features:
        summary_lines.append("%s: 0 rooms" % level_name)
        continue

    by_level[level_name] = level_features

    fname_base = sanitize(FILENAME_MAP.get(level_name, level_name))

    door_features = []
    try:
        door_elems = FilteredElementCollector(doc, v.Id).OfCategory(BuiltInCategory.OST_Doors).WhereElementIsNotElementType()
        for d in door_elems:
            coords = element_local_point(d, v)
            if not coords:
                continue
            if crop_bounds:
                pt_bounds = {"min_x": coords[0], "min_y": coords[1], "max_x": coords[0], "max_y": coords[1]}
                if not bounds_intersect(pt_bounds, crop_bounds):
                    continue
            family_name, type_name = get_type_info(d)
            props = {
                "Element": "Door",
                "Building": selected_building,
                "Type": "Door",
                "kind": "door",
                "Name": type_name or get_param_any(d, "Type Name") or "Door",
                "Family": family_name,
                "Level": level_name,
                "RevitId": element_id_to_int(d.Id),
                "Revit_UniqueId": d.UniqueId,
                "interactive": False
            }
            bearing = element_bearing(d)
            if bearing is not None:
                props["bearing_deg"] = round(bearing, 3)
            door_features.append({"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": coords}})
    except Exception as e:
        print("? Door export error on %s: %s" % (level_name, str(e)))

    if door_features:
        door_path = os.path.join(doors_dir, fname_base + '_Doors.geojson')
        write_feature_collection(door_path, "%s - %s Doors" % (selected_building, level_name), door_features)
        doors_written.append("%s (%d)" % (level_name, len(door_features)))

    stair_features = []
    try:
        stair_seen = set()
        stair_categories = [BuiltInCategory.OST_Stairs, BuiltInCategory.OST_StairsRuns, BuiltInCategory.OST_StairsLandings]
        for bic in stair_categories:
            try:
                stair_elems = FilteredElementCollector(doc, v.Id).OfCategory(bic).WhereElementIsNotElementType()
            except:
                stair_elems = []
            for s in stair_elems:
                revit_id = element_id_to_int(s.Id)
                if revit_id in stair_seen:
                    continue
                stair_seen.add(revit_id)
                coords = element_local_point(s, v)
                if not coords:
                    continue
                if crop_bounds:
                    pt_bounds = {"min_x": coords[0], "min_y": coords[1], "max_x": coords[0], "max_y": coords[1]}
                    if not bounds_intersect(pt_bounds, crop_bounds):
                        continue
                family_name, type_name = get_type_info(s)
                props = {
                    "Element": "Stair",
                    "Building": selected_building,
                    "Type": "Stair",
                    "kind": "stair",
                    "Name": type_name or get_param_any(s, "Type Name") or "Stair",
                    "Family": family_name,
                    "Level": level_name,
                    "RevitId": revit_id,
                    "Revit_UniqueId": s.UniqueId,
                    "interactive": False
                }
                bearing = element_bearing(s)
                if bearing is not None:
                    props["bearing_deg"] = round(bearing, 3)
                stair_features.append({"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": coords}})
    except Exception as e:
        print("? Stair export error on %s: %s" % (level_name, str(e)))

    if stair_features:
        stair_path = os.path.join(stairs_dir, fname_base + '_Stairs.geojson')
        write_feature_collection(stair_path, "%s - %s Stairs" % (selected_building, level_name), stair_features)
        stairs_written.append("%s (%d)" % (level_name, len(stair_features)))

    summary_lines.append("%s: %d rooms" % (level_name, len(level_features)))

combined_written = []
for level_name, feats in by_level.items():
    fname_base = FILENAME_MAP.get(level_name, level_name)
    fname = sanitize(fname_base) + '_Rooms.geojson'
    path = os.path.join(out_dir, fname)
    write_feature_collection(path, "%s - %s" % (selected_building, level_name), feats)
    combined_written.append("%s (%d features)" % (level_name, len(feats)))

TaskDialog.Show(
    "Connected Campus Export Complete",
    "Building: %s\n\nRooms:\n%s\n\nDoors: %s\nStairs: %s\n\nOutput: %s\n\nNo DXF / wall linework was exported by this tool." % (
        selected_building,
        '\n'.join(combined_written) if combined_written else 'none',
        ', '.join(doors_written) if doors_written else 'none',
        ', '.join(stairs_written) if stairs_written else 'none',
        out_dir
    )
)
