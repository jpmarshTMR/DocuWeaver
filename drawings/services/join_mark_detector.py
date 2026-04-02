"""
Join mark detection service using OpenCV.

Scans the border regions of rendered sheet images for join mark shapes
(triangles, arrows, small geometric markers) commonly found on engineering
and architectural drawings.
"""
import logging
import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Detection parameters
BORDER_RATIO = 0.08          # Scan outer 8% of each edge
MIN_CONTOUR_AREA = 80        # Minimum contour area in pixels
MAX_CONTOUR_AREA_RATIO = 0.02  # Max contour area as ratio of border strip area
MIN_TRIANGLE_VERTICES = 3
MAX_TRIANGLE_VERTICES = 6    # Allow some tolerance for imperfect triangles
APPROX_EPSILON_RATIO = 0.04  # Contour approximation precision
CIRCULARITY_THRESHOLD = 0.7  # Above this = circle, below = angular shape
MIN_ASPECT_RATIO = 0.3       # Filter out very elongated shapes (likely text/lines)
MAX_ASPECT_RATIO = 3.0


def detect_join_marks(image_path, border_ratio=BORDER_RATIO):
    """
    Detect potential join marks along the borders of a sheet image.

    Args:
        image_path: Path to the rendered PNG image
        border_ratio: How much of each edge to scan (0.08 = outer 8%)

    Returns:
        List of detected marks:
        [{
            'x': float,         # X position on the full image
            'y': float,         # Y position on the full image
            'edge': str,        # 'top', 'bottom', 'left', 'right'
            'shape': str,       # 'triangle', 'diamond', 'circle', 'arrow'
            'confidence': float, # 0-1 confidence score
            'width': int,       # Bounding box width
            'height': int,      # Bounding box height
            'vertices': int,    # Number of polygon vertices
        }, ...]
    """
    img = cv2.imread(image_path)
    if img is None:
        logger.error("Could not read image: %s", image_path)
        return []

    h, w = img.shape[:2]
    border_w = int(w * border_ratio)
    border_h = int(h * border_ratio)

    all_marks = []

    # Define border strips: (name, x1, y1, x2, y2)
    strips = [
        ('top',    0,          0,          w,          border_h),
        ('bottom', 0,          h - border_h, w,        h),
        ('left',   0,          border_h,   border_w,   h - border_h),
        ('right',  w - border_w, border_h, w,          h - border_h),
    ]

    for edge, x1, y1, x2, y2 in strips:
        strip = img[y1:y2, x1:x2]
        marks = _detect_marks_in_strip(strip, edge, x1, y1, x2 - x1, y2 - y1)
        all_marks.extend(marks)

    # Deduplicate marks that are very close together (within 20px)
    all_marks = _deduplicate_marks(all_marks, min_distance=20)

    # Sort by confidence
    all_marks.sort(key=lambda m: m['confidence'], reverse=True)

    logger.info("Detected %d potential join marks in %s", len(all_marks), image_path)
    return all_marks


def _detect_marks_in_strip(strip, edge, offset_x, offset_y, strip_w, strip_h):
    """Detect join mark shapes within a single border strip."""
    if strip.size == 0:
        return []

    # Convert to grayscale
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)

    # Adaptive threshold to handle varying backgrounds
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 21, 8
    )

    # Clean up noise
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=1)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    strip_area = strip_w * strip_h
    max_contour_area = strip_area * MAX_CONTOUR_AREA_RATIO
    marks = []

    for contour in contours:
        area = cv2.contourArea(contour)

        # Filter by area
        if area < MIN_CONTOUR_AREA or area > max_contour_area:
            continue

        # Get bounding rect
        bx, by, bw, bh = cv2.boundingRect(contour)
        aspect = bw / max(bh, 1)

        # Filter very elongated shapes (lines, text)
        if aspect < MIN_ASPECT_RATIO or aspect > MAX_ASPECT_RATIO:
            continue

        # Approximate polygon
        epsilon = APPROX_EPSILON_RATIO * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        n_vertices = len(approx)

        # Compute circularity
        perimeter = cv2.arcLength(contour, True)
        if perimeter == 0:
            continue
        circularity = 4 * np.pi * area / (perimeter * perimeter)

        # Classify shape and compute confidence
        shape, confidence = _classify_shape(n_vertices, circularity, area, bw, bh)

        if shape is None:
            continue

        # Compute centroid in full-image coordinates
        M = cv2.moments(contour)
        if M['m00'] == 0:
            cx = bx + bw // 2
            cy = by + bh // 2
        else:
            cx = int(M['m10'] / M['m00'])
            cy = int(M['m01'] / M['m00'])

        marks.append({
            'x': float(cx + offset_x),
            'y': float(cy + offset_y),
            'edge': edge,
            'shape': shape,
            'confidence': round(confidence, 3),
            'width': bw,
            'height': bh,
            'vertices': n_vertices,
        })

    return marks


def _classify_shape(n_vertices, circularity, area, bw, bh):
    """
    Classify a contour as a join mark shape.

    Returns (shape_name, confidence) or (None, 0) if not a join mark candidate.
    """
    # Circles: high circularity
    if circularity > CIRCULARITY_THRESHOLD and n_vertices > 5:
        # Small filled circles are common join marks
        confidence = min(circularity, 0.95)
        return 'circle', confidence

    # Triangles: 3 vertices (classic join mark arrow)
    if n_vertices == 3:
        # Triangles are the most common join mark shape
        # Higher confidence for more equilateral triangles
        size_ratio = min(bw, bh) / max(bw, bh)
        confidence = 0.7 + 0.25 * size_ratio
        return 'triangle', confidence

    # Diamonds: 4 vertices with roughly equal sides
    if n_vertices == 4:
        size_ratio = min(bw, bh) / max(bw, bh)
        if size_ratio > 0.5:  # Roughly square/diamond shaped
            confidence = 0.5 + 0.3 * size_ratio
            return 'diamond', confidence

    # Arrow-like shapes: 4-6 vertices, not circular
    if 4 <= n_vertices <= MAX_TRIANGLE_VERTICES and circularity < 0.5:
        confidence = 0.4 + 0.1 * (6 - n_vertices)  # Simpler = more likely
        return 'arrow', confidence

    return None, 0


def _deduplicate_marks(marks, min_distance=20):
    """Remove marks that are very close together, keeping highest confidence."""
    if not marks:
        return marks

    # Sort by confidence descending
    marks.sort(key=lambda m: m['confidence'], reverse=True)
    kept = []

    for mark in marks:
        is_duplicate = False
        for existing in kept:
            dx = mark['x'] - existing['x']
            dy = mark['y'] - existing['y']
            dist = (dx * dx + dy * dy) ** 0.5
            if dist < min_distance:
                is_duplicate = True
                break
        if not is_duplicate:
            kept.append(mark)

    return kept


def compute_alignment(mark_a, sheet_a, mark_b, sheet_b):
    """
    Compute the offset needed to align sheet_b to sheet_a
    based on two linked join marks.

    Args:
        mark_a: JoinMark on sheet A (dict with x, y)
        sheet_a: Sheet A (dict with offset_x, offset_y, rotation)
        mark_b: JoinMark on sheet B (dict with x, y)
        sheet_b: Sheet B (dict with offset_x, offset_y, rotation)

    Returns:
        dict with new offset_x, offset_y for sheet_b
    """
    # Mark positions are in image-local coordinates.
    # Sheet positions on canvas are offset_x, offset_y.
    # To align: mark_a's canvas position should equal mark_b's canvas position.
    #
    # canvas_pos_a = (sheet_a.offset_x + mark_a.x, sheet_a.offset_y + mark_a.y)
    # canvas_pos_b = (sheet_b.offset_x + mark_b.x, sheet_b.offset_y + mark_b.y)
    # We want canvas_pos_a == canvas_pos_b, so:
    # new_offset_b_x = sheet_a.offset_x + mark_a.x - mark_b.x
    # new_offset_b_y = sheet_a.offset_y + mark_a.y - mark_b.y

    new_offset_x = sheet_a['offset_x'] + mark_a['x'] - mark_b['x']
    new_offset_y = sheet_a['offset_y'] + mark_a['y'] - mark_b['y']

    return {
        'offset_x': new_offset_x,
        'offset_y': new_offset_y,
    }
