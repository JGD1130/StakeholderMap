# -*- coding: utf-8 -*-
"""
Mapfluence Production Floorplan Export

Official exporter for Mapfluence floorplans across all projects.
Outputs real-world WGS84 lon/lat floorplan files, converted automatically
from Revit's Site Location + Project Position (no manual origin pick):
  <FLOOR>_Dept_Rooms.geojson

Requires the project's shared coordinates to be set correctly in Revit
(Manage tab -> Location -> Site Location / Coordinates at Point) before
exporting, or the converted coordinates will not land on the real address.
"""

import os, json, re, math, codecs, subprocess, tempfile
import clr

# Revit context
uidoc = __revit__.ActiveUIDocument
doc = uidoc.Document
view = doc.ActiveView

# Core imports
clr.AddReference("System")
clr.AddReference("System.Windows.Forms")
from System.Collections.Generic import List
from System.Windows.Forms import FolderBrowserDialog, DialogResult

clr.AddReference('RevitAPI')
clr.AddReference('RevitAPIUI')
from Autodesk.Revit.UI import TaskDialog

from Autodesk.Revit.DB import (
    FilteredElementCollector, BuiltInCategory, BuiltInParameter,
    SpatialElementBoundaryOptions, SpatialElementBoundaryLocation,
    ViewPlan, ViewType, Phase, StorageType, DXFExportOptions, ElementId, XYZ
)

# =============================================================================
# CONFIGURATION
# =============================================================================
TARGET_PHASE_NAMES = ["Existing", "New Construction"]
RESTRICT_TO_PHASE = True
RESTRICT_TO_LEVELS = True
ALLOWED_LEVELS = [
    "BASEMENT",
    "LEVEL 1", "LEVEL 1 - OVERALL", "LEVEL 1 - AREA A", "LEVEL 1 - AREA B",
    "LEVEL 2", "LEVEL 3", "LEVEL 4", "LEVEL 5",
]
FILENAME_MAP = {
    "BASEMENT": "BASEMENT_Dept", "LEVEL 1": "LEVEL_1_Dept", 
    "LEVEL 2": "LEVEL_2_Dept", "LEVEL 3": "LEVEL_3_Dept",
    "LEVEL 4": "LEVEL_4_Dept", "LEVEL 5": "LEVEL_5_Dept"
}
DXF_UNITS_PER_FOOT = 12.0
OGR2OGR_PATH = None
OGR2OGR_CANDIDATES = [
    r"C:\Users\jdohrman\AppData\Local\Programs\OSGeo4W\bin\ogr2ogr.exe",
    r"C:\OSGeo4W\bin\ogr2ogr.exe",
    r"C:\OSGeo4W64\bin\ogr2ogr.exe",
    r"C:\Program Files\QGIS 3.34.0\bin\ogr2ogr.exe",
    r"C:\Program Files\QGIS 3.36.0\bin\ogr2ogr.exe",
    r"C:\Program Files\QGIS 3.38.0\bin\ogr2ogr.exe",
]
PREFERRED_KEYWORDS = ["Overall", "Map Export"]
EXCLUDE_KEYWORDS = ["Area", "Working", "Demo", "New", "Furniture"]
EXPORT_ROOM_LEVELS_ONLY = True
KEEP_INTERIOR_FURNITURE = True
DRAWING_BBOX_PAD_FEET = 25.0
VIEW_CROP_BBOX_PAD_FEET = 5.0
DXF_INCLUDE_LAYERS = set([
    "A-DOOR",
    "A-GLAZ-CURT",
    "A-GLAZ-CWMG",
    "A-WALL",
    "A-WALL-PATT",
    "I-FURN",
    "I-FURN-PNLS",
    "I-WALL",
    "P-SANR-FIXT",
    "Q-CASE",
    "S-STRS",
])
DXF_INCLUDE_LAYER_PREFIXES = [
    "A-GLAZ-",
    "A-WALL-",
    "I-WALL-",
    "S-STRS-",
]
DXF_EXCLUDE_LAYERS = set([
    "A-AREA-BNDY",
    "A-AREA-IDEN",
    "A-DETL",
    "G-IMPT",
    "Q-SPCQ",
])
DXF_EXCLUDE_GEOMETRY_TYPES = set(["Point", "MultiPoint"])
DXF_ALLOWED_FILL_TEXT = set(["SOLID"])

# =============================================================================
# GUARDS
# =============================================================================
if not isinstance(view, ViewPlan):
    TaskDialog.Show("Mapfluence Export", "Switch to a Floor Plan view.")
    raise SystemExit

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================
def sanitize(name):
    return re.sub(r'[^A-Za-z0-9_\-]+', "_", (name or "").strip())

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

def resolve_ogr2ogr_path():
    if OGR2OGR_PATH and os.path.exists(OGR2OGR_PATH):
        return OGR2OGR_PATH
    for cand in OGR2OGR_CANDIDATES:
        if cand and os.path.exists(cand):
            return cand
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

def get_first_prop(props, keys):
    for key in keys:
        try:
            val = props.get(key)
        except:
            val = None
        if val:
            return val
    return ""

def get_dxf_layer(feature):
    props = feature.get("properties") or {}
    return (get_first_prop(props, ["Layer", "layer", "LAYER"]) or "").strip().upper()

def get_dxf_subclasses(feature):
    props = feature.get("properties") or {}
    return (get_first_prop(props, ["SubClasses", "Subclasses", "subclasses"]) or "").strip().lower()

def get_dxf_text_value(feature):
    props = feature.get("properties") or {}
    return (get_first_prop(props, [
        "Text", "text", "TEXT",
        "PlainText", "plainText", "PLAINTEXT",
        "EntityText", "entityText", "ENTITYTEXT",
    ]) or "").strip()

def should_keep_dxf_feature(feature):
    if not feature:
        return False
    geom = feature.get("geometry") or {}
    geom_type = geom.get("type") or ""
    if not geom_type or geom_type in DXF_EXCLUDE_GEOMETRY_TYPES:
        return False

    subclasses = get_dxf_subclasses(feature)
    if "acdbmtext" in subclasses or "acdbtext" in subclasses:
        return False
    text_value = get_dxf_text_value(feature)
    if text_value and text_value.upper() not in DXF_ALLOWED_FILL_TEXT:
        return False

    layer = get_dxf_layer(feature)
    if not layer:
        return False
    if layer in DXF_EXCLUDE_LAYERS:
        return False
    if not KEEP_INTERIOR_FURNITURE and layer == "I-FURN":
        return False
    if layer in DXF_INCLUDE_LAYERS:
        return True
    for prefix in DXF_INCLUDE_LAYER_PREFIXES:
        if layer.startswith(prefix):
            return True
    return False

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

def union_bounds(a, b):
    if a and b:
        return {
            "min_x": min(a["min_x"], b["min_x"]),
            "min_y": min(a["min_y"], b["min_y"]),
            "max_x": max(a["max_x"], b["max_x"]),
            "max_y": max(a["max_y"], b["max_y"]),
        }
    if a:
        return dict(a)
    if b:
        return dict(b)
    return None

def bounds_intersect(a, b):
    if not a or not b:
        return False
    return not (
        a["max_x"] < b["min_x"] or
        a["min_x"] > b["max_x"] or
        a["max_y"] < b["min_y"] or
        a["min_y"] > b["max_y"]
    )

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

def write_feature_collection(path, title, features):
    fc = {
        "type": "FeatureCollection",
        "name": title,
        "features": features
    }
    with codecs.open(path, "w", "utf-8") as f:
        json.dump(fc, f, indent=2)

def is_better_view(new_view, current_view):
    new_name = new_view.Name.lower() if new_view.Name else ""
    cur_name = current_view.Name.lower() if current_view.Name else ""
    active_view_id = element_id_to_int(view.Id) if view else -1
    if element_id_to_int(new_view.Id) == active_view_id:
        return True
    if element_id_to_int(current_view.Id) == active_view_id:
        return False
    for bad in EXCLUDE_KEYWORDS:
        if bad.lower() in new_name:
            return False
        if bad.lower() in cur_name:
            return True
    new_score = sum(1 for kw in PREFERRED_KEYWORDS if kw.lower() in new_name)
    cur_score = sum(1 for kw in PREFERRED_KEYWORDS if kw.lower() in cur_name)
    if new_score != cur_score:
        return new_score > cur_score
    return len(new_view.Name or "") < len(current_view.Name or "")

# =============================================================================
# PHASE CHECK
# =============================================================================
TARGET_PHASES = []
TARGET_PHASE_IDS = set()
if RESTRICT_TO_PHASE:
    for _pname in TARGET_PHASE_NAMES:
        _ph = get_phase_by_name(doc, _pname)
        if _ph:
            TARGET_PHASES.append(_ph)
            TARGET_PHASE_IDS.add(element_id_to_int(_ph.Id))
    if not TARGET_PHASES:
        TaskDialog.Show("Mapfluence Export", "None of these phases found:\n%s" % "\n".join(TARGET_PHASE_NAMES))
        raise SystemExit

# =============================================================================
# OUTPUT FOLDER SELECTION
# =============================================================================
dlg = FolderBrowserDialog()
dlg.Description = "Choose output folder for FINAL GEOJSON files"
if dlg.ShowDialog() != DialogResult.OK:
    raise SystemExit
out_dir = dlg.SelectedPath
if not os.path.exists(out_dir):
    os.makedirs(out_dir)

# =============================================================================
# REAL-WORLD (WGS84) COORDINATE CONVERSION
# =============================================================================
# Converts Revit internal feet coordinates directly to lon/lat using the
# project's Site Location (true-north-referenced lat/lon) and Project Position
# (the internal origin's rotation + offset relative to that reference point).
# No manual origin pick — this only produces correct results if the project's
# shared coordinates were actually set in Revit (Manage tab -> Location ->
# Site Location / Coordinates at Point) to the real-world address/coordinates.
FEET_PER_DEGREE_LAT = 364000.0

site_location = doc.SiteLocation
base_lat_rad = site_location.Latitude
base_lon_rad = site_location.Longitude

project_position = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero)
project_angle = project_position.Angle       # radians: Project North -> True North rotation
project_east = project_position.EastWest     # feet
project_north = project_position.NorthSouth  # feet

_cos_base_lat = math.cos(base_lat_rad)
_feet_per_degree_lon = FEET_PER_DEGREE_LAT * _cos_base_lat if abs(_cos_base_lat) > 1e-9 else FEET_PER_DEGREE_LAT

def ft_to_local(x, y):
    # Rotate project XY into the true-north-aligned frame. Revit's Angle is
    # measured from Project North to True North; if converted points come out
    # mirrored/rotated 180 deg from real geography on first test, flip the
    # sign of project_angle here.
    cos_a = math.cos(project_angle)
    sin_a = math.sin(project_angle)
    rx = x * cos_a - y * sin_a
    ry = x * sin_a + y * cos_a

    # Shift by the project position offset (internal origin -> shared origin).
    east = rx + project_east
    north = ry + project_north

    # Feet -> degrees, added onto the site's base lat/lon.
    lon = math.degrees(base_lon_rad) + (east / _feet_per_degree_lon)
    lat = math.degrees(base_lat_rad) + (north / FEET_PER_DEGREE_LAT)
    return [lon, lat]

def view_crop_local_bounds(view_plan, pad=0.0):
    try:
        if not view_plan or not getattr(view_plan, "CropBoxActive", False):
            return None
        crop = view_plan.CropBox
        if not crop:
            return None
        tf = getattr(crop, "Transform", None)
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
            "min_x": min(pt[0] for pt in pts),
            "min_y": min(pt[1] for pt in pts),
            "max_x": max(pt[0] for pt in pts),
            "max_y": max(pt[1] for pt in pts),
        }
        return expand_bounds(bounds, pad) if pad else bounds
    except:
        return None

def ring_ft_to_local(ring):
    return [ft_to_local(x, y) for x, y in ring]

TaskDialog.Show(
    "REAL-WORLD COORDINATES DETECTED",
    "Site Latitude: %.6f\nSite Longitude: %.6f\nProject North rotation: %.2f deg\n"
    "Project position offset: EastWest=%.1f ft, NorthSouth=%.1f ft\n\n"
    "Export will use real-world lon/lat coordinates automatically — no origin pick needed." % (
        math.degrees(base_lat_rad), math.degrees(base_lon_rad),
        math.degrees(project_angle), project_east, project_north
    )
)

# =============================================================================
# ROOMS EXTRACTION
# =============================================================================
TaskDialog.Show("Rooms", "Extracting room boundaries...")
by_level = {}
room_bounds_by_level = {}
sbo = SpatialElementBoundaryOptions()
sbo.SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.CoreCenter

rooms = FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType()
for r in rooms:
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

    lvl = r.Level
    if not lvl:
        continue
    lvl_name = lvl.Name
    
    if RESTRICT_TO_LEVELS and ALLOWED_LEVELS and lvl_name not in ALLOWED_LEVELS:
        continue

    if lvl_name not in by_level:
        by_level[lvl_name] = []

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
    
    _occ_raw = get_param_by_name(r, "NCES_Occupancy Status") or get_param_any(r, "Occupancy Status")
    props = {
        "Element": "Room",
        "Number": get_str_param(r, BuiltInParameter.ROOM_NUMBER),
        "Name": get_str_param(r, BuiltInParameter.ROOM_NAME),
        "NCES_Type": get_param_any(r, "NCES Types"),
        "NCES_Department": get_param_any(r, "NCES_Dept"),
        "NCES_Occupancy Status": _occ_raw,
        "occupancyStatus": _occ_raw if _occ_raw else "Occupied",
        "Workstations": get_param_any(r, "NCES_Workstations") or get_param_any(r, "Workstations"),
        "Seat Count": get_param_by_name(r, "NCES_Seat Count") or get_param_any(r, "Seat Count"),
        "Level": lvl_name,
        "Area_SF": round(r.Area, 2),
        "RevitId": element_id_to_int(r.Id),
        "Revit_UniqueId": r.UniqueId
    }
    
    feat = {"type": "Feature", "properties": props, "geometry": geom}
    by_level[lvl_name].append(feat)

    bounds = geometry_bounds(geom)
    if bounds:
        existing = room_bounds_by_level.get(lvl_name)
        if not existing:
            room_bounds_by_level[lvl_name] = dict(bounds)
        else:
            existing["min_x"] = min(existing["min_x"], bounds["min_x"])
            existing["min_y"] = min(existing["min_y"], bounds["min_y"])
            existing["max_x"] = max(existing["max_x"], bounds["max_x"])
            existing["max_y"] = max(existing["max_y"], bounds["max_y"])

TaskDialog.Show("Rooms ready", "%d rooms across %d levels" % (sum(len(f) for f in by_level.values()), len(by_level)))

ogr2ogr_exe = resolve_ogr2ogr_path()
if not ogr2ogr_exe:
    TaskDialog.Show(
        "Mapfluence Export",
        "ogr2ogr.exe was not found.\n\n"
        "DXF architectural linework merge cannot run, so the export will not match the Hastings-style floorplan look."
    )
    raise SystemExit

# =============================================================================
# DXF FLOOR PLANS - FIXED VERSION
# =============================================================================
def transform_coords_from_dxf(geom, units_per_foot):
    if not geom or "type" not in geom:
        return geom
    gtype = geom["type"]
    coords = geom.get("coordinates")
    if not coords:
        return geom

    def tp(pt):
        x_ft = pt[0] / units_per_foot
        y_ft = pt[1] / units_per_foot
        return ft_to_local(x_ft, y_ft)

    if gtype == "Point":
        geom["coordinates"] = tp(coords)
    elif gtype == "LineString":
        geom["coordinates"] = [tp(pt) for pt in coords]
    elif gtype == "Polygon":
        geom["coordinates"] = [[tp(pt) for pt in ring] for ring in coords]
    elif gtype == "MultiPolygon":
        geom["coordinates"] = [[[tp(pt) for pt in ring] for ring in poly] for poly in coords]
    elif gtype == "MultiLineString":
        geom["coordinates"] = [[tp(pt) for pt in line] for line in coords]
    return geom

TaskDialog.Show("DXF Export", "Creating DXF files...")

# Create DXF folder
dxf_dir = os.path.join(out_dir, "DXF")
if not os.path.exists(dxf_dir):
    os.makedirs(dxf_dir)

# ✅ FIXED: Store view + level name TOGETHER
views_by_level = {}
view_bounds_by_level = {}
room_level_names = set(by_level.keys())
active_view_id = element_id_to_int(view.Id) if view else -1
for v in FilteredElementCollector(doc).OfClass(ViewPlan):
    if v.ViewType != ViewType.FloorPlan or v.IsTemplate:
        continue
    phase_param = v.get_Parameter(BuiltInParameter.VIEW_PHASE)
    if not phase_param:
        continue
    phase = doc.GetElement(phase_param.AsElementId())
    if not phase or (RESTRICT_TO_PHASE and phase.Name not in TARGET_PHASE_NAMES):
        continue
    lvl = v.GenLevel
    if not lvl:
        continue
    lvl_id = element_id_to_int(lvl.Id)
    lvl_name = lvl.Name          # ✅ FIXED: Store level name
    if EXPORT_ROOM_LEVELS_ONLY and room_level_names and lvl_name not in room_level_names:
        continue
    if element_id_to_int(v.Id) == active_view_id:
        views_by_level[lvl_id] = (v, lvl_name)
        crop_bounds = view_crop_local_bounds(v, VIEW_CROP_BBOX_PAD_FEET)
        if crop_bounds:
            view_bounds_by_level[lvl_name] = crop_bounds
        continue
    if lvl_id not in views_by_level or is_better_view(v, views_by_level[lvl_id][0]):
        views_by_level[lvl_id] = (v, lvl_name)  # ✅ FIXED: Store tuple (view, level_name)
        crop_bounds = view_crop_local_bounds(v, VIEW_CROP_BBOX_PAD_FEET)
        if crop_bounds:
            view_bounds_by_level[lvl_name] = crop_bounds

views = list(views_by_level.values())
opts = DXFExportOptions()
opts.ExportingAreas = True

exported_dxf_files = []
TaskDialog.Show("DXF Export", "Exporting %d views..." % len(views))
for v, lvl_name in views:
    name = v.Name.replace(" ", "_").replace("/", "_").replace("\\", "_")
    dxf_path = os.path.join(dxf_dir, name + ".dxf")
    
    view_ids = List[ElementId]()
    view_ids.Add(v.Id)
    
    if doc.Export(dxf_dir, name, view_ids, opts):
        exported_dxf_files.append((dxf_path, lvl_name))  # ✅ FIXED: Store with level name
        print("✓ Exported: %s → %s" % (name, lvl_name))

# =============================================================================
# DOORS + STAIRS OVERLAYS
# =============================================================================
doors_dir = os.path.join(out_dir, "Doors")
stairs_dir = os.path.join(out_dir, "Stairs")
for folder in [doors_dir, stairs_dir]:
    if not os.path.exists(folder):
        os.makedirs(folder)

doors_written = []
stairs_written = []

TaskDialog.Show("Overlays", "Exporting door and stair overlays...")
for v, lvl_name in views:
    fname_base = sanitize(FILENAME_MAP.get(lvl_name, lvl_name))

    door_features = []
    try:
        door_elems = FilteredElementCollector(doc, v.Id).OfCategory(BuiltInCategory.OST_Doors).WhereElementIsNotElementType()
        for d in door_elems:
            coords = element_local_point(d, v)
            if not coords:
                continue
            family_name, type_name = get_type_info(d)
            props = {
                "Element": "Door",
                "Type": "Door",
                "kind": "door",
                "Name": type_name or get_param_any(d, "Type Name") or "Door",
                "Family": family_name,
                "Level": lvl_name,
                "RevitId": element_id_to_int(d.Id),
                "Revit_UniqueId": d.UniqueId,
                "interactive": False
            }
            bearing = element_bearing(d)
            if bearing is not None:
                props["bearing_deg"] = round(bearing, 3)
            door_features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": coords}
            })
    except Exception as e:
        print("✗ Door export error on %s: %s" % (lvl_name, str(e)))

    if door_features:
        door_path = os.path.join(doors_dir, fname_base + "_Doors.geojson")
        write_feature_collection(door_path, "%s - %s Doors" % (doc.Title, lvl_name), door_features)
        doors_written.append("%s (%d)" % (lvl_name, len(door_features)))
        print("✓ Wrote doors for %s (%d)" % (lvl_name, len(door_features)))

    stair_features = []
    try:
        stair_seen = set()
        stair_categories = [
            BuiltInCategory.OST_Stairs,
            BuiltInCategory.OST_StairsRuns,
            BuiltInCategory.OST_StairsLandings
        ]
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
                family_name, type_name = get_type_info(s)
                props = {
                    "Element": "Stair",
                    "Type": "Stair",
                    "kind": "stair",
                    "Name": type_name or get_param_any(s, "Type Name") or "Stair",
                    "Family": family_name,
                    "Level": lvl_name,
                    "RevitId": revit_id,
                    "Revit_UniqueId": s.UniqueId,
                    "interactive": False
                }
                bearing = element_bearing(s)
                if bearing is not None:
                    props["bearing_deg"] = round(bearing, 3)
                stair_features.append({
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "Point", "coordinates": coords}
                })
    except Exception as e:
        print("✗ Stair export error on %s: %s" % (lvl_name, str(e)))

    if stair_features:
        stair_path = os.path.join(stairs_dir, fname_base + "_Stairs.geojson")
        write_feature_collection(stair_path, "%s - %s Stairs" % (doc.Title, lvl_name), stair_features)
        stairs_written.append("%s (%d)" % (lvl_name, len(stair_features)))
        print("✓ Wrote stairs for %s (%d)" % (lvl_name, len(stair_features)))

# ✅ FIXED: Process with KNOWN level names - NO string matching needed
walls_written = 0
dxf_features_kept = 0
dxf_features_dropped = 0
TaskDialog.Show("DXF Processing", "Converting %d DXF → GeoJSON..." % len(exported_dxf_files))
for dxf_path, known_level in exported_dxf_files:
    dxf_name = os.path.basename(dxf_path)
    temp_geojson = os.path.join(tempfile.gettempdir(), dxf_name.replace(".dxf", ".geojson"))
    
    try:
        cmd = [ogr2ogr_exe, "-f", "GeoJSON", temp_geojson, dxf_path, 
               "-nlt", "PROMOTE_TO_MULTI", "-dim", "XY", "-skipfailures"]
        subprocess.check_call(cmd)
        
        if not os.path.exists(temp_geojson):
            print("✗ No GeoJSON for %s" % dxf_name)
            continue
            
        # ✅ FIXED: Use codecs.open for IronPython 2.7
        with codecs.open(temp_geojson, "r", "utf-8") as f:
            data = json.load(f)
        
        feature_count = len(data.get("features", []))
        print("DXF %s → %d features" % (dxf_name, feature_count))
        
        if feature_count == 0:
            print("✗ Empty GeoJSON for %s" % dxf_name)
            os.remove(temp_geojson)
            continue
        
        for feature in data.get("features", []):
            if feature.get("geometry"):
                feature["geometry"] = transform_coords_from_dxf(feature["geometry"], DXF_UNITS_PER_FOOT)

        if known_level in by_level:
            padded_room_bounds = expand_bounds(room_bounds_by_level.get(known_level), DRAWING_BBOX_PAD_FEET)
            # Detached wings can be visible in the export view even when rooms are sparse
            # or missing there, so union the room envelope with the active view crop.
            merge_clip_bounds = union_bounds(padded_room_bounds, view_bounds_by_level.get(known_level))
            for feat in data.get("features", []):
                if not feat.get("geometry"):
                    continue
                props = feat.get("properties") or {}
                props["type"] = "drawing"
                props["level"] = known_level
                props["source"] = dxf_name
                props["interactive"] = False
                feat["properties"] = props
                feat_bounds = geometry_bounds(feat.get("geometry"))
                within_clip_bounds = True if not merge_clip_bounds else bounds_intersect(feat_bounds, merge_clip_bounds)
                if should_keep_dxf_feature(feat) and within_clip_bounds:
                    by_level[known_level].append(feat)
                    dxf_features_kept += 1
                else:
                    dxf_features_dropped += 1
            walls_written += 1
            print("✓ MERGED %s → %s (%d features)" % (dxf_name, known_level, feature_count))
        else:
            print("✗ Level '%s' missing from rooms" % known_level)
        
        os.remove(temp_geojson)
        
    except Exception as e:
        print("✗ Error %s: %s" % (dxf_name, str(e)))
        if os.path.exists(temp_geojson):
            os.remove(temp_geojson)
        continue

TaskDialog.Show("DXF Complete", "%d/%d DXF files merged" % (walls_written, len(exported_dxf_files)))

# DEBUG: Show final counts
debug_msg = "FINAL COUNTS:\n"
for lvl, feats in by_level.items():
    room_count = sum(1 for f in feats if f.get("properties", {}).get("Element") == "Room")
    drawing_count = sum(1 for f in feats if f.get("properties", {}).get("type") == "drawing")
    debug_msg += "%s: %d rooms + %d drawings = %d total\n" % (lvl, room_count, drawing_count, len(feats))
TaskDialog.Show("DEBUG FINAL", debug_msg)

# =============================================================================
# FINAL OUTPUT FILES
# =============================================================================
combined_written = []
for lvl, feats in by_level.items():
    if not feats:
        continue
    fc = {
        "type": "FeatureCollection",
        "name": "%s - %s" % (doc.Title, lvl),
        "features": feats
    }
    fname_base = FILENAME_MAP.get(lvl, lvl)
    fname = sanitize(fname_base) + "_Rooms.geojson"
    path = os.path.join(out_dir, fname)
    with codecs.open(path, "w", "utf-8") as f:
        json.dump(fc, f, indent=2)
    combined_written.append("%s (%d features)" % (lvl, len(feats)))

TaskDialog.Show(
    "✅ MAPFLUENCE FLOORPLAN EXPORT COMPLETE",
    "PRODUCTION FILES:\n%s\n\nDoors: %s\nStairs: %s\nDXF source: %s (%d)\nMerged: %d\nDXF kept: %d\nDXF dropped: %d\nOutput: %s" % (
        "\n".join(combined_written),
        ", ".join(doors_written) if doors_written else "none",
        ", ".join(stairs_written) if stairs_written else "none",
        dxf_dir, len(exported_dxf_files), walls_written, dxf_features_kept, dxf_features_dropped, out_dir
    )
)
