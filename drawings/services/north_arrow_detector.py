"""
North arrow detection service using OpenCV.

Detects north arrows on engineering/architectural drawing sheets and
determines their orientation angle so sheets can be auto-rotated to
align north upward.

Strategy:
1. Look for the letter "N" using template matching and contour analysis
2. Find nearby arrow/triangle shapes pointing in a specific direction
3. Determine the arrow's orientation via minimum-area bounding rectangle
4. Return the rotation needed to point north upward (toward top of image)
"""
import logging
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Detection parameters
SEARCH_SCALE = 0.5           # Downscale image for faster processing
MIN_ARROW_AREA = 200         # Minimum arrow contour area (at search scale)
MAX_ARROW_AREA_RATIO = 0.01  # Max arrow area as ratio of image area
N_SEARCH_RADIUS = 300        # How far from an "N" to look for an arrow (at search scale)
MIN_ARROW_ASPECT = 1.5       # Minimum aspect ratio for arrow bounding rect (elongated)


def detect_north_arrow(image_path):
    """
    Detect the north arrow on a sheet image and return the rotation
    angle needed to orient north upward.

    Args:
        image_path: Path to the rendered PNG image

    Returns:
        dict or None:
        {
            'angle': float,        # Current arrow angle (degrees from vertical, CW positive)
            'correction': float,   # Rotation to apply to sheet (degrees) to point north up
            'x': float,            # Arrow center X on original image
            'y': float,            # Arrow center Y on original image
            'confidence': float,   # 0-1 confidence score
            'method': str,         # Detection method used
        }
        Returns None if no north arrow found.
    """
    img = cv2.imread(image_path)
    if img is None:
        logger.error("Could not read image: %s", image_path)
        return None

    h, w = img.shape[:2]

    # Work at reduced scale for speed
    scale = SEARCH_SCALE
    small = cv2.resize(img, (int(w * scale), int(h * scale)))
    sh, sw = small.shape[:2]

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    # Try method 1: Find "N" text + nearby arrow
    result = _find_n_with_arrow(gray, small, sw, sh, scale)
    if result:
        return result

    # Try method 2: Find isolated arrow shapes in likely title block areas
    result = _find_standalone_arrow(gray, small, sw, sh, scale)
    if result:
        return result

    logger.info("No north arrow detected in %s", image_path)
    return None


def _find_n_with_arrow(gray, img, sw, sh, scale):
    """
    Find the letter "N" on the drawing using contour analysis,
    then look for a nearby arrow shape to determine direction.
    """
    # Threshold
    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 10
    )

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    image_area = sw * sh
    n_candidates = []

    for contour in contours:
        area = cv2.contourArea(contour)

        # "N" letter: moderate size, roughly rectangular
        if area < 100 or area > image_area * 0.002:
            continue

        bx, by, bw, bh = cv2.boundingRect(contour)
        aspect = bh / max(bw, 1)

        # "N" is taller than wide or roughly square
        if aspect < 0.8 or aspect > 2.5:
            continue
        if bw < 8 or bh < 10:
            continue

        # Check if this region contains an "N"-like pattern
        # Extract the region and check for the diagonal stroke of "N"
        roi = gray[by:by+bh, bx:bx+bw]
        if _looks_like_n(roi, bw, bh):
            cx = bx + bw // 2
            cy = by + bh // 2
            n_candidates.append({
                'x': cx, 'y': cy,
                'w': bw, 'h': bh,
                'area': area,
            })

    if not n_candidates:
        return None

    # For each N candidate, look for a nearby arrow
    for n_cand in n_candidates:
        arrow = _find_arrow_near(thresh, contours, n_cand, sw, sh, scale)
        if arrow:
            return arrow

    return None


def _looks_like_n(roi, bw, bh):
    """
    Heuristic check if a grayscale ROI looks like the letter "N".
    The letter N has two vertical strokes and a diagonal connecting them.
    """
    if bw < 6 or bh < 8:
        return False

    _, binary = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Check left edge, right edge, and diagonal have ink
    third_w = max(bw // 3, 1)
    left_col = binary[:, :third_w]
    right_col = binary[:, -third_w:]

    left_density = np.count_nonzero(left_col) / max(left_col.size, 1)
    right_density = np.count_nonzero(right_col) / max(right_col.size, 1)

    # Both vertical strokes should have significant ink
    if left_density < 0.2 or right_density < 0.2:
        return False

    # Check for diagonal: sample the middle band
    mid_density = np.count_nonzero(binary[:, third_w:-third_w]) / max(binary[:, third_w:-third_w].size, 1)
    if mid_density < 0.1:
        return False

    return True


def _find_arrow_near(thresh, contours, n_cand, sw, sh, scale):
    """
    Find an arrow-shaped contour near a detected "N" letter.
    Return the north arrow result dict if found.
    """
    nx, ny = n_cand['x'], n_cand['y']

    best_arrow = None
    best_score = 0

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < MIN_ARROW_AREA or area > sw * sh * MAX_ARROW_AREA_RATIO:
            continue

        bx, by, bw, bh = cv2.boundingRect(contour)
        cx = bx + bw // 2
        cy = by + bh // 2

        # Must be near the "N"
        dist = ((cx - nx) ** 2 + (cy - ny) ** 2) ** 0.5
        if dist > N_SEARCH_RADIUS or dist < 5:
            continue

        # Check elongation — arrows are typically elongated
        rect = cv2.minAreaRect(contour)
        rect_w, rect_h = rect[1]
        if min(rect_w, rect_h) == 0:
            continue
        elongation = max(rect_w, rect_h) / min(rect_w, rect_h)
        if elongation < MIN_ARROW_ASPECT:
            continue

        # Approximate to polygon — arrows typically have 5-8 vertices
        epsilon = 0.03 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        n_verts = len(approx)
        if n_verts < 3 or n_verts > 10:
            continue

        # Score: prefer closer to N, more elongated, triangle-like
        proximity_score = 1.0 - (dist / N_SEARCH_RADIUS)
        shape_score = min(elongation / 3.0, 1.0)
        vert_score = 1.0 if 3 <= n_verts <= 5 else 0.5
        score = proximity_score * 0.4 + shape_score * 0.4 + vert_score * 0.2

        if score > best_score:
            best_score = score
            best_arrow = {
                'contour': contour,
                'rect': rect,
                'cx': cx, 'cy': cy,
                'score': score,
            }

    if not best_arrow or best_score < 0.3:
        return None

    # Determine arrow direction using the contour's principal axis
    angle = _get_arrow_angle(best_arrow['contour'], best_arrow['rect'], nx, ny)

    correction = -angle  # Rotation needed to point north up

    return {
        'angle': round(angle, 2),
        'correction': round(correction, 2),
        'x': round(best_arrow['cx'] / scale, 1),
        'y': round(best_arrow['cy'] / scale, 1),
        'confidence': round(min(best_score, 0.95), 3),
        'method': 'n_with_arrow',
    }


def _find_standalone_arrow(gray, img, sw, sh, scale):
    """
    Look for arrow shapes in the title block areas (corners and bottom strip)
    without requiring an "N" letter nearby.
    """
    # Search regions: bottom-right quadrant, bottom strip, right strip
    regions = [
        ('bottom_right', sw // 2, sh // 2, sw, sh),
        ('bottom_left', 0, sh // 2, sw // 2, sh),
        ('top_right', sw // 2, 0, sw, sh // 2),
        ('top_left', 0, 0, sw // 2, sh // 2),
    ]

    thresh = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 10
    )

    best_result = None
    best_confidence = 0

    for region_name, rx1, ry1, rx2, ry2 in regions:
        region_thresh = thresh[ry1:ry2, rx1:rx2]
        contours, _ = cv2.findContours(region_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        region_area = (rx2 - rx1) * (ry2 - ry1)

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < MIN_ARROW_AREA * 2 or area > region_area * MAX_ARROW_AREA_RATIO:
                continue

            rect = cv2.minAreaRect(contour)
            rect_w, rect_h = rect[1]
            if min(rect_w, rect_h) == 0:
                continue
            elongation = max(rect_w, rect_h) / min(rect_w, rect_h)
            if elongation < 2.0:
                continue

            epsilon = 0.03 * cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, epsilon, True)
            n_verts = len(approx)

            # Strong arrow indicators: 3-7 vertices, elongated
            if n_verts < 3 or n_verts > 7:
                continue

            # Check if it's a filled triangle/arrow (high solidity)
            hull = cv2.convexHull(contour)
            hull_area = cv2.contourArea(hull)
            if hull_area == 0:
                continue
            solidity = area / hull_area
            if solidity < 0.4:
                continue

            bx, by, bw, bh = cv2.boundingRect(contour)
            cx = rx1 + bx + bw // 2
            cy = ry1 + by + bh // 2

            # Offset contour to full-image coords for angle calculation
            offset_contour = contour.copy()
            offset_contour[:, :, 0] += rx1
            offset_contour[:, :, 1] += ry1
            offset_rect = cv2.minAreaRect(offset_contour)

            shape_score = min(elongation / 3.0, 1.0)
            vert_score = 1.0 if n_verts == 3 else 0.7 if n_verts <= 5 else 0.4
            confidence = shape_score * 0.5 + vert_score * 0.3 + solidity * 0.2
            # Standalone arrows get a confidence penalty vs N-assisted
            confidence *= 0.7

            if confidence > best_confidence:
                best_confidence = confidence
                angle = _get_arrow_angle(offset_contour, offset_rect)

                best_result = {
                    'angle': round(angle, 2),
                    'correction': round(-angle, 2),
                    'x': round(cx / scale, 1),
                    'y': round(cy / scale, 1),
                    'confidence': round(min(confidence, 0.95), 3),
                    'method': 'standalone_arrow',
                }

    if best_result and best_confidence >= 0.25:
        return best_result

    return None


def _get_arrow_angle(contour, rect, n_x=None, n_y=None):
    """
    Determine the direction an arrow points, in degrees from vertical
    (0 = pointing up/north, 90 = pointing right/east, etc.)

    Uses the minimum-area rectangle angle and the contour's tip
    (furthest point from centroid or from the "N" letter).
    """
    # Get the centroid
    M = cv2.moments(contour)
    if M['m00'] == 0:
        return 0
    cx = int(M['m10'] / M['m00'])
    cy = int(M['m01'] / M['m00'])

    # Find the tip: the point furthest from the centroid
    # (or furthest from the N if we know where N is)
    ref_x = n_x if n_x is not None else cx
    ref_y = n_y if n_y is not None else cy

    max_dist = 0
    tip_x, tip_y = cx, cy
    for pt in contour:
        px, py = pt[0]
        d = (px - ref_x) ** 2 + (py - ref_y) ** 2
        if d > max_dist:
            max_dist = d
            tip_x, tip_y = px, py

    # Angle from centroid to tip
    # atan2 gives angle from positive X axis, CCW positive
    # We want angle from positive Y axis (up), CW positive
    dx = tip_x - cx
    dy = -(tip_y - cy)  # Flip Y since image Y is inverted

    angle_rad = np.arctan2(dx, dy)  # angle from north (up), CW positive
    angle_deg = np.degrees(angle_rad)

    return angle_deg
