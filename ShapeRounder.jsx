/*
    Shape Rounder Tool for Adobe Photoshop
    ========================================
    Version: 1.5 (Added "Custom Corners" Mode)
    This script rounds the sharp corners of any selected path or vector shape
    (work path, vector mask, or shape layer) in Photoshop. It includes options
    to round all points, filter by angle, or round specific points/corners with custom radii.
    A Point Type filter allows targeting only inner (concave) or outer (convex) points/corners,
    and this filter now dynamically updates the list shown in Custom Points/Corners modes.
    "Only Corners" mode specifically targets geometric corners (intersections of straight lines).
    Uses the original rounding formula and corrected inner/outer detection.
*/

// Function to get the name of the currently selected path in the Paths panel
function getSelectedPathName()
{
    var ref = new ActionReference();
    ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("PthN"));
    ref.putEnumerated(charIDToTypeID("Path"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    try
    {
        var desc = executeActionGet(ref);
        if (desc.hasKey(charIDToTypeID("PthN")))
        {
            return desc.getString(charIDToTypeID("PthN"));
        }
        else
        {
            // Handle Work Path which might not have a name property
            var pathKindRef = new ActionReference();
            pathKindRef.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("PthK")); // Path Kind property
            pathKindRef.putEnumerated(charIDToTypeID("Path"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var kindDesc = executeActionGet(pathKindRef);
            if (kindDesc.hasKey(charIDToTypeID("PthK")))
            {
                var kindEnum = typeIDToStringID(kindDesc.getEnumerationValue(charIDToTypeID("PthK")));
                if (kindEnum === 'workPath')
                {
                    return ""; // Return empty string to represent Work Path
                }
            }
            return null; // Not Work Path and no name
        }
    }
    catch (e)
    {
        return null; // Error or no path selected
    }
}

(function main()
{
    // ------------------------------
    // Document & Path Check
    // ------------------------------
    if (!app.documents.length)
    {
        alert("No document open.");
        return;
    }

    var doc = app.activeDocument;
    // Compute a scaling factor so new coordinates match a 72ppi canvas.
    var scaleFactor = 72 / doc.resolution;

    var validPaths = [];
    var seenPathSignatures = {}; // key: name + anchorCount

    // Gather paths from PathItems (Work Path, named paths)
    if (doc.pathItems && doc.pathItems.length > 0)
    {
        for (var i = 0; i < doc.pathItems.length; i++)
        {
            var path = doc.pathItems[i];
            // Ignore Clipping Paths and paths without points
            if (path && path.kind !== PathKind.CLIPPINGPATH && hasAnchorPoints(path))
            {
                var anchorCount = 0;
                try
                {
                    // Add try-catch for potentially invalid subPathItems access
                    for (var s = 0; s < path.subPathItems.length; s++)
                    {
                        if (path.subPathItems[s] && path.subPathItems[s].pathPoints)
                        {
                            anchorCount += path.subPathItems[s].pathPoints.length;
                        }
                    }
                }
                catch (subPathError)
                {
                    // Ignore paths that cause errors accessing subpaths/points
                    continue;
                }

                if (anchorCount > 0) // Only add if it has points
                {
                    var sig = path.name + "::" + anchorCount;
                    if (!seenPathSignatures[sig])
                    {
                        validPaths.push(path);
                        seenPathSignatures[sig] = true;
                    }
                }
            }
        }
    }

    // Note: This script does not explicitly check Shape Layers or Vector Masks.
    // It relies on the path being present in doc.pathItems (e.g., target the path in the Paths panel).

    if (validPaths.length === 0)
    {
        alert(
            "No valid, non-clipping paths with anchor points found in the Paths panel.\n" +
            "Make sure the desired path (Work Path, Shape Path, Vector Mask Path) is selectable in the Paths panel."
        );
        return;
    }

    var selectedPathName = getSelectedPathName();
    var defaultIndex = 0;
    if (selectedPathName !== null) // Can be "" for Work Path
    {
        for (var i = 0; i < validPaths.length; i++)
        {
            if (validPaths[i].name === selectedPathName)
            {
                // Extra check for Work Path kind if name is empty
                if (selectedPathName === "" && validPaths[i].kind !== PathKind.WORKPATH)
                {
                    continue; // Skip unnamed non-workpaths if Work Path was intended
                }
                defaultIndex = i;
                break;
            }
        }
    }

    // ------------------------------
    // Global Variables & Defaults
    // ------------------------------
    var defaultParams =
    {
        radius: 30,
        flatness: 0,         // 0%
        minAngle: 0,
        maxAngle: 180,
        editMode: 0,         // Default: Edit All Points (Index 0)
        pointTypeFilter: 0   // Default: All (Index 0)
    };

    var params =
    {
        radius: defaultParams.radius,
        flatness: defaultParams.flatness,
        minAngle: defaultParams.minAngle,
        maxAngle: defaultParams.maxAngle,
        editMode: defaultParams.editMode,
        pointTypeFilter: defaultParams.pointTypeFilter,
        customRadii: {} // Use object for sparse storage { globalIndex: radius }
    };

    var lastUsedGlobalRadius = params.radius; // store current Global Radius
    var action = "cancel";
    var origPathData = null;
    var pointControls = []; // UI controls currently visible in the paginated list

    // Pagination variables for Custom Points list
    var currentPage = 0;
    var itemsPerPage = 5; // default

    // MODIFIED: fullPointList now holds the FILTERED list of points for the UI
    var fullPointList = [];
    // Stores the state {selected, radius} for ALL points, keyed by original globalIndex
    var pointSelections = {};
    var pointEqualityTolerance = 1e-6; // Tolerance for comparing point coordinates

    // --- Vector Math Helpers (defined early for use in populatePointList) ---
    function vectorLength(v)
    {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    }

    function normalizeVector(v)
    {
        var l = vectorLength(v);
        if (l < 1e-9) return [0, 0];
        return [v[0] / l, v[1] / l];
    }

    function scaleVector(v, s)
    {
        return [v[0] * s, v[1] * s];
    }

    function addVectors(a, b)
    {
        return [a[0] + b[0], a[1] + b[1]];
    }

    function subtractVectors(a, b)
    {
        return [a[0] - b[0], a[1] - b[1]];
    }

    function getPointType(p0_anchor, p1_anchor, p2_anchor) // Determine Point Type: -1 Inner, 1 Outer, 0 Straight
    {
        if (!p0_anchor || !p1_anchor || !p2_anchor) return 0;
        var v1 = subtractVectors(p0_anchor, p1_anchor);
        var v2 = subtractVectors(p2_anchor, p1_anchor);
        var crossProduct = v1[0] * v2[1] - v1[1] * v2[0];
        var epsilon = 1e-9;
        if (Math.abs(crossProduct) < epsilon) return 0;
        else if (crossProduct > 0) return -1; // Inner (Y-down)
        else return 1; // Outer (Y-down)
    }

    // Helper to compare two points (arrays) within a tolerance
    function pointsAreEqual(p1, p2, tolerance)
    {
        if (!p1 || !p2 || p1.length !== 2 || p2.length !== 2) return false;
        var tol = tolerance || pointEqualityTolerance;
        return (
            Math.abs(p1[0] - p2[0]) < tol &&
            Math.abs(p1[1] - p2[1]) < tol
        );
    }

    // Helper to check if a point is a geometric corner
    function isGeometricCorner(point, prevPoint, nextPoint, isClosedSubpath)
    {
        // Must have valid neighbors
        if (!point || !prevPoint || !nextPoint ||
            !point.anchor || !prevPoint.anchor || !nextPoint.anchor)
        {
            return false;
        }

        // Check point kind and handle positions
        var isCornerKind = (point.kind === PointKind.CORNERPOINT);
        var handlesAtAnchor =
            pointsAreEqual(point.anchor, point.leftDirection) &&
            pointsAreEqual(point.anchor, point.rightDirection);

        // Also check if the segments leading to/from the point are straight (handles point directly at neighbors).
        // For this request, we stick to the simpler v1.4 definition: corner = CORNERPOINT + handles at anchor.

        return (isCornerKind && handlesAtAnchor);
    }

    // ------------------------------
    // Helper: Scale a 2-element point by a factor
    // ------------------------------
    function scalePoint(pt, factor)
    {
        return [pt[0] * factor, pt[1] * factor];
    }

    // ------------------------------
    // Build the ScriptUI Panel
    // ------------------------------
    var dlg = new Window("dialog", "Shape Rounder v1.5"); // Version bump
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.margins = 15;
    dlg.spacing = 10;

    // --- Path Selection ---
    var pathGroup = dlg.add("group");
    pathGroup.alignment = ["fill", "top"];
    pathGroup.add("statictext", undefined, "Select Path:");
    var pathNames = [];
    for (var i = 0; i < validPaths.length; i++)
    {
        var displayName = validPaths[i].name;
        if (displayName === "" && validPaths[i].kind === PathKind.WORKPATH)
        {
            displayName = "(Work Path)";
        }
        else if (displayName === "")
        {
            displayName = "(Unnamed Path " + i + ")";
        }
        pathNames.push(displayName);
    }

    var pathDropdown = pathGroup.add("dropdownlist", undefined, pathNames);
    pathDropdown.selection = defaultIndex;
    pathDropdown.preferredSize.width = 250;

    // --- Round Mode Selection ---
    var modeGroup = dlg.add("group");
    modeGroup.alignment = ["fill", "top"];
    modeGroup.add("statictext", undefined, "Round Mode:");
    // ADDED "Custom Corners"
    var editModeDropdown = modeGroup.add(
        "dropdownlist",
        undefined,
        ["Edit All Points", "Only Corners", "Custom Points", "Custom Corners"]
    );
    editModeDropdown.selection = params.editMode;
    editModeDropdown.preferredSize.width = 250;

    // --- Panel for Global/Angle/Type Settings ---
    var settingsPanel = dlg.add("panel", undefined, "Settings");
    settingsPanel.orientation = "column";
    settingsPanel.alignChildren = ["fill", "top"];
    settingsPanel.margins = [10, 15, 10, 10];
    settingsPanel.spacing = 8;

    // --- Global Radius ---
    var radiusGroup = settingsPanel.add("group");
    radiusGroup.alignment = ["fill", "top"];
    radiusGroup.add("statictext", undefined, "Global Radius (px):");
    var radiusInput = radiusGroup.add("edittext", undefined, params.radius.toString());
    radiusInput.characters = 6;

    // --- Flatness ---
    var flatnessGroup = settingsPanel.add("group");
    flatnessGroup.alignment = ["fill", "top"];
    flatnessGroup.add("statictext", undefined, "Flatness (%):");
    var flatnessInput = flatnessGroup.add("edittext", undefined, (params.flatness * 100).toString());
    flatnessInput.characters = 6;

    // --- Point Type Filter ---
    var pointTypeGroup = settingsPanel.add("group");
    pointTypeGroup.alignment = ["fill", "top"];
    pointTypeGroup.add("statictext", undefined, "Point Type:");
    var pointTypeDropdown = pointTypeGroup.add("dropdownlist", undefined, ["All", "Inner", "Outer"]);
    pointTypeDropdown.selection = params.pointTypeFilter;
    pointTypeDropdown.preferredSize.width = 180;

    // --- Angle Filters (Min/Max) ---
    var grpMin = settingsPanel.add("group");
    grpMin.orientation = "row";
    grpMin.alignment = ["fill", "center"];
    grpMin.add("statictext", undefined, "Min Angle (°):");
    var minAngleSlider = grpMin.add("slider", undefined, params.minAngle, 0, 180);
    minAngleSlider.preferredSize.width = 150;
    var minAngleLabel = grpMin.add("statictext", undefined, params.minAngle.toString());
    minAngleLabel.characters = 4;
    minAngleSlider.onChanging = function()
    {
        minAngleLabel.text = Math.round(this.value);
    };

    var grpMax = settingsPanel.add("group");
    grpMax.orientation = "row";
    grpMax.alignment = ["fill", "center"];
    grpMax.add("statictext", undefined, "Max Angle (°):");
    var maxAngleSlider = grpMax.add("slider", undefined, params.maxAngle, 0, 180);
    maxAngleSlider.preferredSize.width = 150;
    var maxAngleLabel = grpMax.add("statictext", undefined, params.maxAngle.toString());
    maxAngleLabel.characters = 4;
    maxAngleSlider.onChanging = function()
    {
        maxAngleLabel.text = Math.round(this.value);
    };

    // --- Container Group for Custom Points/Corners Panel ---
    var customPointsContainer = dlg.add("group");
    customPointsContainer.orientation = "column";
    customPointsContainer.alignChildren = ["fill", "fill"];
    customPointsContainer.margins = 0;
    customPointsContainer.spacing = 0;
    // Visible if mode is Custom Points (2) or Custom Corners (3)
    customPointsContainer.visible = (params.editMode === 2 || params.editMode === 3);

    // --- Panel for Custom Points/Corners List ---
    // Title will be updated dynamically
    var pointScrollPanel = customPointsContainer.add("panel", undefined, "Custom List");
    pointScrollPanel.alignChildren = ["fill", "top"];
    pointScrollPanel.margins = [10, 15, 10, 10];
    pointScrollPanel.spacing = 5;
    pointScrollPanel.preferredSize.height = 100; // Fixed height

    // --- Group inside the Custom List Panel to hold point controls ---
    var pointGroup = pointScrollPanel.add("group");
    pointGroup.orientation = "column";
    pointGroup.alignChildren = ["fill", "top"];
    pointGroup.margins = 0;
    pointGroup.spacing = 2;

    // --- Pagination Buttons ---
    var paginationGroup = customPointsContainer.add("group");
    paginationGroup.orientation = "row";
    paginationGroup.alignment = ["center", "top"];
    paginationGroup.spacing = 10;
    var prevBtn = paginationGroup.add("button", undefined, "Previous");
    var nextBtn = paginationGroup.add("button", undefined, "Next");

    prevBtn.onClick = function()
    {
        if (currentPage > 0)
        {
            currentPage--;
            renderCurrentPage();
        }
    };

    nextBtn.onClick = function()
    {
        if (currentPage < totalPages - 1)
        {
            currentPage++;
            renderCurrentPage();
        }
    };

    // --- Button Row for Reset/Cancel/Apply ---
    var btns = dlg.add("group");
    btns.orientation = "row";
    btns.alignment = ["center", "bottom"];
    btns.alignChildren = ["center", "center"];

    var applyBtn = btns.add("button", undefined, "Apply", { name: "ok" });
    var resetBtn = btns.add("button", undefined, "Reset UI");
    var cancelBtn = btns.add("button", undefined, "Cancel", { name: "cancel" });

    // --- UI Helper Functions ---

    // Adjusts itemsPerPage based on the *filtered* fullPointList length
    function updateItemsPerPage()
    {
        if (fullPointList.length === 0) itemsPerPage = 1;
        else if (fullPointList.length <= 5) itemsPerPage = fullPointList.length;
        else itemsPerPage = 5;
    }

    // Renders the current page based on the *filtered* fullPointList
    function renderCurrentPage()
    {
        // Save current UI states before re-rendering (important!)
        for (var i = 0; i < pointControls.length; i++)
        {
            var ctrl = pointControls[i];
            var currentRadius = parseFloat(ctrl.input.text);
            if (isNaN(currentRadius) || currentRadius < 0)
            {
                currentRadius = lastUsedGlobalRadius;
            }

            // Update the main state object using the control's globalIndex
            if (pointSelections[ctrl.globalIndex])
            {
                pointSelections[ctrl.globalIndex].selected = ctrl.checkbox.value;
                pointSelections[ctrl.globalIndex].radius = currentRadius;
            }
        }

        // Clear UI list
        while (pointGroup.children.length > 0)
        {
            pointGroup.remove(pointGroup.children[0]);
        }
        pointControls = []; // Reset visible controls array

        // Calculate indices for the current page from the filtered list
        var start = currentPage * itemsPerPage;
        var end = Math.min(start + itemsPerPage, fullPointList.length);

        if (fullPointList.length === 0)
        {
            var filterText = ["All", "Inner", "Outer"][pointTypeDropdown.selection.index];
            pointGroup.add("statictext", undefined, "No points match filter: '" + filterText + "'.");
        }
        else
        {
            for (var i = start; i < end; i++)
            {
                var ptData = fullPointList[i]; // Get data from filtered list
                var row = pointGroup.add("group");
                row.orientation = "row";
                row.alignment = ["fill", "center"];
                row.spacing = 5;

                var chk = row.add("checkbox", undefined, "");

                // Label uses original globalIndex
                var label = row.add(
                    "statictext",
                    undefined,
                    "P" + ptData.globalIndex + ": [" +
                    ptData.anchor[0].toFixed(1) + ", " +
                    ptData.anchor[1].toFixed(1) + "]"
                );
                label.preferredSize.width = 180;

                var pointRadiusInput = row.add("edittext", undefined, "");
                pointRadiusInput.characters = 5;
                pointRadiusInput.enabled = false;

                // Restore state from the main pointSelections object
                // using the original globalIndex
                var stored = pointSelections[ptData.globalIndex];
                if (stored)
                {
                    chk.value = stored.selected;
                    pointRadiusInput.text = stored.radius.toString();
                    pointRadiusInput.enabled = stored.selected;
                }
                else
                {
                    // Should have been initialized in populatePointList, but fallback just in case
                    pointSelections[ptData.globalIndex] =
                    {
                        selected: false,
                        radius: lastUsedGlobalRadius
                    };
                    pointRadiusInput.text = lastUsedGlobalRadius.toString();
                }

                // Link checkbox to input enabled state and update main state object
                chk.onClick = (function(inputField, gIndex)
                {
                    return function()
                    {
                        inputField.enabled = this.value;
                        if (pointSelections[gIndex])
                        {
                            pointSelections[gIndex].selected = this.value;
                        }
                    };
                })(pointRadiusInput, ptData.globalIndex);

                // Update radius in main state object on change
                pointRadiusInput.onChange = (function(gIndex)
                {
                    return function()
                    {
                        if (pointSelections[gIndex])
                        {
                            var r = parseFloat(this.text);
                            if (!isNaN(r) && r >= 0)
                            {
                                pointSelections[gIndex].radius = r;
                            }
                            else
                            {
                                this.text = pointSelections[gIndex].radius.toString(); // Revert
                            }
                        }
                    };
                })(ptData.globalIndex);

                // Add control references for saving state later
                pointControls.push(
                {
                    globalIndex: ptData.globalIndex,
                    checkbox: chk,
                    input: pointRadiusInput
                });
            }
        }

        // Add dummy rows if needed (less critical with fixed panel height)
        var displayed = end - start;
        var missing = itemsPerPage - displayed;
        for (var j = 0; j < missing; j++)
        {
            var dummy = pointGroup.add("group");
            dummy.preferredSize.height = 20;
            dummy.visible = false;
        }

        // Update pagination buttons
        prevBtn.enabled = (currentPage > 0);
        nextBtn.enabled = (currentPage < totalPages - 1);
        var showNav = (totalPages > 1);
        prevBtn.visible = showNav;
        nextBtn.visible = showNav;

        dlg.layout.layout(true);
    }

    // MODIFIED: Populates fullPointList based on pathItem, editMode, AND pointTypeFilter
    function populatePointList(pathItem)
    {
        fullPointList = []; // Clear the filtered list
        var currentFilter = pointTypeDropdown.selection.index; // 0=All, 1=Inner, 2=Outer
        var currentMode = editModeDropdown.selection.index;    // 0=All, 1=Corners, 2=Custom Points, 3=Custom Corners
        var globalPointIndex = 0;

        if (pathItem && pathItem.subPathItems)
        {
            try
            {
                for (var s = 0; s < pathItem.subPathItems.length; s++)
                {
                    var sp = pathItem.subPathItems[s];
                    if (!sp || !sp.pathPoints) continue;
                    var pts = sp.pathPoints;
                    var len = pts.length;

                    for (var p = 0; p < len; p++)
                    {
                        var anchorPt = pts[p];
                        // Basic check for point data validity
                        if (
                            !anchorPt ||
                            !anchorPt.anchor ||
                            anchorPt.kind === undefined ||
                            anchorPt.leftDirection === undefined ||
                            anchorPt.rightDirection === undefined
                        )
                        {
                            globalPointIndex++;
                            continue; // Skip points with incomplete data
                        }

                        // Initialize selection state for this point if it doesn't exist
                        if (!pointSelections[globalPointIndex])
                        {
                            pointSelections[globalPointIndex] =
                            {
                                selected: false,
                                radius: lastUsedGlobalRadius
                            };
                        }

                        // --- Filtering Logic for the List ---
                        var includePointInList = false;

                        // Need neighbors to determine geometric corner status or point type
                        var prev = sp.closed ? pts[(p - 1 + len) % len] : (p > 0 ? pts[p - 1] : null);
                        var nxt = sp.closed ? pts[(p + 1) % len] : (p < len - 1 ? pts[p + 1] : null);
                        var hasValidNeighbors = (prev && nxt && prev.anchor && nxt.anchor);

                        var isGeomCorner = false;
                        if (hasValidNeighbors)
                        {
                            isGeomCorner = isGeometricCorner(anchorPt, prev, nxt, sp.closed);
                        }

                        var pointType = 0; // 0=Straight, -1=Inner, 1=Outer
                        if (hasValidNeighbors)
                        {
                            pointType = getPointType(prev.anchor, anchorPt.anchor, nxt.anchor);
                        }
                        // else: Endpoints are considered type 0 for filtering

                        // --- Decide whether to include in the list based on Edit Mode and Point Type Filter ---
                        if (currentMode === 2) // Custom Points mode
                        {
                            // List ALL points that match Point Type Filter
                            if (currentFilter === 0) // All filter
                            {
                                includePointInList = true; // Include all points
                            }
                            else // Inner/Outer filter
                            {
                                if (hasValidNeighbors)
                                {
                                    if (currentFilter === 1 && pointType === -1) includePointInList = true; // Inner
                                    else if (currentFilter === 2 && pointType === 1) includePointInList = true; // Outer
                                }
                                // Endpoints excluded if filter is Inner/Outer
                            }
                        }
                        else if (currentMode === 3) // Custom Corners mode
                        {
                            // List ONLY Geometric Corners that match Point Type Filter
                            if (isGeomCorner)
                            {
                                if (currentFilter === 0) // All filter
                                {
                                    includePointInList = true; // Include all geometric corners
                                }
                                else // Inner/Outer filter
                                {
                                    if (currentFilter === 1 && pointType === -1) includePointInList = true;
                                    else if (currentFilter === 2 && pointType === 1) includePointInList = true;
                                }
                            }
                            // Non-geometric corners or endpoints are excluded in Custom Corners mode
                        }
                        else
                        {
                            // Should not happen when populating list for custom modes, but safety fallback
                            includePointInList = true;
                        }

                        if (includePointInList)
                        {
                            fullPointList.push(
                            {
                                globalIndex: globalPointIndex,
                                subpathIndex: s,
                                pointIndex: p,
                                anchor: anchorPt.anchor.slice()
                            });
                        }

                        globalPointIndex++;
                    }
                }
            }
            catch (e)
            {
                alert(
                    "Error reading path points. The selected path might be corrupted.\n\n" + e
                );
                fullPointList = [];
                pointSelections = {};
            }
        }

        // Update the panel title based on the current mode
        if (currentMode === 2) pointScrollPanel.text = "Custom Points";
        else if (currentMode === 3) pointScrollPanel.text = "Custom Corners";
        else pointScrollPanel.text = "Custom List"; // Fallback

        updateItemsPerPage();
        totalPages = (itemsPerPage > 0 && fullPointList.length > 0)
            ? Math.ceil(fullPointList.length / itemsPerPage)
            : 0;
        currentPage = 0;
        renderCurrentPage();
    }

    // Clears the point list UI and shows a message
    function clearPointListUI(message)
    {
        while (pointGroup.children.length > 0)
        {
            pointGroup.remove(pointGroup.children[0]);
        }
        pointControls = [];
        if (message)
        {
            pointGroup.add("statictext", undefined, message);
        }
        prevBtn.visible = false;
        nextBtn.visible = false;
        dlg.layout.layout(true);
    }

    // Updates UI element states based on selected mode
    function updateUIMode()
    {
        var mode = editModeDropdown.selection.index; // 0, 1, 2, or 3

        // Enable/disable settings based on mode
        // Radius, Min/Max Angle are disabled for *both* Custom modes (2 and 3)
        radiusGroup.enabled = (mode !== 2 && mode !== 3);
        flatnessGroup.enabled = true; // Always enabled
        pointTypeGroup.enabled = true; // Always enabled
        grpMin.enabled = (mode === 1);
        grpMax.enabled = (mode === 1);

        // Show/hide Custom Points/Corners panel
        customPointsContainer.visible = (mode === 2 || mode === 3);

        // Populate list if entering *either* custom mode
        if (mode === 2 || mode === 3)
        {
            lastUsedGlobalRadius = parseFloat(radiusInput.text) || defaultParams.radius;
            if (validPaths.length > 0 && pathDropdown.selection !== null)
            {
                var idx = pathDropdown.selection.index;
                if (idx >= 0 && idx < validPaths.length)
                {
                    populatePointList(validPaths[idx]);
                }
                else
                {
                    clearPointListUI("Error: Invalid path index.");
                }
            }
            else
            {
                clearPointListUI("No path selected.");
            }
        }
        else
        {
            // Leaving Custom modes: clear the list UI
            clearPointListUI("Select a Custom mode to view points.");
        }

        dlg.layout.layout(true);
    }

    // --- Initial Setup ---
    clearPointListUI("Select a Custom mode to view points.");
    updateUIMode();
    dlg.layout.layout(true);
    dlg.layout.resize();

    // --- Event Handlers ---
    pathDropdown.onChange = function()
    {
        if (this.selection !== null)
        {
            var idx = this.selection.index;
            var currentMode = editModeDropdown.selection.index;
            // If in *either* Custom mode, update the list when path changes
            if (idx >= 0 && idx < validPaths.length && (currentMode === 2 || currentMode === 3))
            {
                populatePointList(validPaths[idx]);
            }
        }
        else
        {
            var currentMode = editModeDropdown.selection.index;
            if (currentMode === 2 || currentMode === 3)
            {
                clearPointListUI("No path selected.");
            }
        }
    };

    editModeDropdown.onChange = updateUIMode;

    pointTypeDropdown.onChange = function()
    {
        var currentMode = editModeDropdown.selection.index;
        // If we are currently in *either* Custom mode, changing the filter should update the list
        if (currentMode === 2 || currentMode === 3)
        {
            if (validPaths.length > 0 && pathDropdown.selection !== null)
            {
                var idx = pathDropdown.selection.index;
                if (idx >= 0 && idx < validPaths.length)
                {
                    populatePointList(validPaths[idx]);
                }
                else
                {
                    clearPointListUI("Error: Invalid path index.");
                }
            }
            else
            {
                clearPointListUI("No path selected.");
            }
        }
    };

    resetBtn.onClick = function()
    {
        radiusInput.text = defaultParams.radius.toString();
        flatnessInput.text = (defaultParams.flatness * 100).toString();
        minAngleSlider.value = defaultParams.minAngle;
        minAngleLabel.text = defaultParams.minAngle.toString();
        maxAngleSlider.value = defaultParams.maxAngle;
        maxAngleLabel.text = defaultParams.maxAngle.toString();
        editModeDropdown.selection = defaultParams.editMode;
        pointTypeDropdown.selection = defaultParams.pointTypeFilter;

        pointSelections = {};
        lastUsedGlobalRadius = defaultParams.radius;
        updateUIMode();
    };

    applyBtn.onClick = function()
    {
        var selectedIndex = pathDropdown.selection.index;
        if (selectedIndex < 0 || selectedIndex >= validPaths.length)
        {
            alert("Error: No valid path selected.");
            action = "cancel";
            return;
        }

        var selectedPath = validPaths[selectedIndex];

        // Save current page's UI state one last time
        var currentMode = editModeDropdown.selection.index;
        if (currentMode === 2 || currentMode === 3)
        {
            for (var i = 0; i < pointControls.length; i++)
            {
                var ctrl = pointControls[i];
                var rVal = parseFloat(ctrl.input.text);
                if (isNaN(rVal) || rVal < 0)
                {
                    rVal = lastUsedGlobalRadius;
                }
                if (pointSelections[ctrl.globalIndex])
                {
                    pointSelections[ctrl.globalIndex].selected = ctrl.checkbox.value;
                    pointSelections[ctrl.globalIndex].radius = rVal;
                }
            }
        }

        // Store settings from UI into params object
        params.radius = parseFloat(radiusInput.text);
        if (isNaN(params.radius) || params.radius < 0) params.radius = 0;

        params.flatness = parseFloat(flatnessInput.text) / 100.0;
        if (isNaN(params.flatness) || params.flatness < 0) params.flatness = 0;
        if (params.flatness > 1) params.flatness = 1;

        params.minAngle = Math.round(minAngleSlider.value);
        params.maxAngle = Math.round(maxAngleSlider.value);
        params.editMode = currentMode;
        params.pointTypeFilter = pointTypeDropdown.selection.index;

        // Compile final customRadii object from the *complete* pointSelections state
        params.customRadii = {};
        for (var key in pointSelections)
        {
            if (pointSelections.hasOwnProperty(key))
            {
                var selData = pointSelections[key];
                if (selData.selected && selData.radius > 0)
                {
                    params.customRadii[parseInt(key)] = selData.radius;
                }
            }
        }

        // --- Backup ---
        try
        {
            origPathData = duplicatePathData(selectedPath);
            if (!origPathData || !hasPointsDeep(origPathData))
            {
                throw new Error("Path backup failed or resulted in empty data.");
            }
            action = "apply";
            dlg.close();
        }
        catch (e)
        {
            alert(
                "Critical Error: Failed to back up original path.\n\n" +
                e + "\n\nAborting."
            );
            action = "cancel";
        }
    };

    cancelBtn.onClick = function()
    {
        action = "cancel";
        dlg.close();
    };

    dlg.center();
    dlg.show();

    // --- Process Path ---
    if (action === "apply")
    {
        var selectedIndex = pathDropdown.selection.index;
        if (selectedIndex >= 0 && selectedIndex < validPaths.length)
        {
            var finalSelectedPath = validPaths[selectedIndex];
            try
            {
                processPath(finalSelectedPath, params);
            }
            catch (e)
            {
                // Error Handling & Restore
                alert("Error during rounding:\n\n" + e + "\n\nAttempting restore...");
                if (origPathData)
                {
                    try
                    {
                        var pathRestored = findPathPotentiallyRenamed(finalSelectedPath.name);
                        if (pathRestored)
                        {
                            restorePath(pathRestored, origPathData);
                            alert(
                                "Original path restored to '" + pathRestored.name +
                                "'.\nManual Undo may be needed."
                            );
                        }
                        else
                        {
                            alert("Error: Could not find backup path '(Original)' to restore.");
                        }
                    }
                    catch (restoreError)
                    {
                        alert("Error during restore:\n\n" + restoreError);
                    }
                }
                else
                {
                    alert("Error: No backup data available.");
                }
            }
        }
        else
        {
            alert("Internal error: Invalid path index.");
        }
    }

    // ------------------------------
    // Core Logic & Helper Functions
    // ------------------------------
    function hasAnchorPoints(pathItem)
    {
        if (!pathItem || !pathItem.subPathItems || typeof pathItem.subPathItems.length === 'undefined')
        {
            return false;
        }
        try
        {
            for (var i = 0; i < pathItem.subPathItems.length; i++)
            {
                var sp = pathItem.subPathItems[i];
                if (
                    sp &&
                    sp.pathPoints &&
                    typeof sp.pathPoints.length !== 'undefined' &&
                    sp.pathPoints.length > 0
                )
                {
                    return true;
                }
            }
        }
        catch (e)
        {
            return false;
        }
        return false;
    }

    function hasPointsDeep(backupData)
    {
        if (!backupData || backupData.length === 0) return false;
        for (var i = 0; i < backupData.length; i++)
        {
            if (backupData[i] && backupData[i].points && backupData[i].points.length > 0)
            {
                return true;
            }
        }
        return false;
    }

    function findPathPotentiallyRenamed(originalBaseName)
    {
        var baseNameClean = originalBaseName.replace(/ \((Original|Rounded|Restored.*)\)( \(\d+\))?$/, '');
        var expectedOriginalName = baseNameClean + " (Original)";

        try
        {
            return app.activeDocument.pathItems.getByName(expectedOriginalName);
        }
        catch (e) {}

        var i = 1;
        while (i <= 50)
        {
            var numberedName = expectedOriginalName + " (" + i + ")";
            try
            {
                return app.activeDocument.pathItems.getByName(numberedName);
            }
            catch (e) {}
            i++;
        }

        try
        {
            return app.activeDocument.pathItems.getByName(originalBaseName);
        }
        catch (e) {}

        return null;
    }

    function nameExists(name)
    {
        try
        {
            app.activeDocument.pathItems.getByName(name);
            return true;
        }
        catch (e)
        {
            return false;
        }
    }

    function duplicatePathData(pathItem)
    {
        if (!hasAnchorPoints(pathItem)) return [];
        var subPathsBackup = [];
        try
        {
            for (var i = 0; i < pathItem.subPathItems.length; i++)
            {
                var sp = pathItem.subPathItems[i];
                if (!sp || !sp.pathPoints) continue;
                var ptsBackup = [];
                for (var j = 0; j < sp.pathPoints.length; j++)
                {
                    var p = sp.pathPoints[j];
                    if (
                        p &&
                        p.anchor &&
                        p.leftDirection &&
                        p.rightDirection &&
                        p.kind !== undefined
                    )
                    {
                        ptsBackup.push(
                        {
                            anchor: p.anchor.slice(),
                            leftDirection: p.leftDirection.slice(),
                            rightDirection: p.rightDirection.slice(),
                            kind: p.kind
                        });
                    }
                }
                if (ptsBackup.length > 0)
                {
                    subPathsBackup.push(
                    {
                        operation: sp.operation,
                        closed: sp.closed,
                        points: ptsBackup
                    });
                }
            }
        }
        catch (e)
        {
            throw new Error("Failed to copy path data: " + e);
        }
        return subPathsBackup;
    }

    function restorePath(pathItemToReplace, backupData)
    {
        var originalName = pathItemToReplace.name;
        if (!backupData || !hasPointsDeep(backupData))
        {
            throw new Error("Restore failed: Invalid backup data.");
        }

        var newSubPathInfoArray = [];
        for (var i = 0; i < backupData.length; i++)
        {
            var subPathBackup = backupData[i];
            if (!subPathBackup || !subPathBackup.points || subPathBackup.points.length === 0)
            {
                continue;
            }

            var spinfo = new SubPathInfo();
            spinfo.operation = subPathBackup.operation;
            spinfo.closed = subPathBackup.closed;

            var pathPointInfoArray = [];
            for (var j = 0; j < subPathBackup.points.length; j++)
            {
                var data = subPathBackup.points[j];
                if (
                    !data ||
                    !data.anchor ||
                    !data.leftDirection ||
                    !data.rightDirection ||
                    data.kind === undefined
                )
                {
                    continue;
                }

                var pinfo = new PathPointInfo();
                pinfo.anchor = data.anchor.slice();
                pinfo.leftDirection = data.leftDirection.slice();
                pinfo.rightDirection = data.rightDirection.slice();
                pinfo.kind = data.kind;
                pathPointInfoArray.push(pinfo);
            }

            if (pathPointInfoArray.length > 0)
            {
                spinfo.entireSubPath = pathPointInfoArray;
                newSubPathInfoArray.push(spinfo);
            }
        }

        if (newSubPathInfoArray.length === 0)
        {
            throw new Error("Restore failed: No valid subpaths from backup.");
        }

        var tempPathFocus = null;
        try
        {
            try
            {
                pathItemToReplace.deselect();
            }
            catch (e) {}

            tempPathFocus = app.activeDocument.pathItems.add("___TempRestoreFocus___", []);
            tempPathFocus.select();
            pathItemToReplace.remove();
        }
        catch (removeError)
        {
            try
            {
                if (tempPathFocus) tempPathFocus.remove();
            }
            catch (e2) {}
            throw new Error("Failed to remove target path for restoration: " + removeError);
        }
        finally
        {
            try
            {
                if (tempPathFocus) tempPathFocus.remove();
            }
            catch (e2) {}
        }

        var restoredBaseName = originalName.replace(/ \((Original|Rounded|Restored.*)\)( \(\d+\))?$/, '');
        var finalRestoredName = restoredBaseName + " (Restored)";
        var counter = 1;
        while (nameExists(finalRestoredName))
        {
            finalRestoredName = restoredBaseName + " (Restored " + counter + ")";
            counter++;
            if (counter > 50)
            {
                throw new Error("Restore failed: Could not find unique name.");
            }
        }

        var restoredPath = app.activeDocument.pathItems.add(finalRestoredName, newSubPathInfoArray);
        restoredPath.select();
    }

    // --- Main Path Processing Function --- (Handles all modes)
    function processPath(pathItem, params)
    {
        var newSubPaths = [];
        var globalPointCounter = 0;

        for (var i = 0; i < pathItem.subPathItems.length; i++)
        {
            var sp = pathItem.subPathItems[i];
            var pts = sp.pathPoints;
            var len = pts.length;
            var pointProcessingData = [];
            var currentSubPathGlobalStartIndex = globalPointCounter;

            // Handle paths too small to have corners
            if ((len < 2 && !sp.closed) || (len < 3 && sp.closed))
            {
                var originalPoints = [];
                for (var k = 0; k < len; k++)
                {
                    var p = pts[k];
                    var pinfo = new PathPointInfo();
                    pinfo.anchor = scalePoint(p.anchor, scaleFactor);
                    pinfo.leftDirection = scalePoint(p.leftDirection, scaleFactor);
                    pinfo.rightDirection = scalePoint(p.rightDirection, scaleFactor);
                    pinfo.kind = p.kind;
                    originalPoints.push(pinfo);
                    globalPointCounter++;
                }
                if (originalPoints.length > 0)
                {
                    var spinfoCopy = new SubPathInfo();
                    spinfoCopy.operation = sp.operation;
                    spinfoCopy.closed = sp.closed;
                    spinfoCopy.entireSubPath = originalPoints;
                    newSubPaths.push(spinfoCopy);
                }
                continue;
            }

            // Process each point in the subpath
            for (var j = 0; j < len; j++)
            {
                var currentGlobalIndex = currentSubPathGlobalStartIndex + j;
                var curr = pts[j];
                var prev = sp.closed ? pts[(j - 1 + len) % len] : (j > 0 ? pts[j - 1] : null);
                var nxt = sp.closed ? pts[(j + 1) % len] : (j < len - 1 ? pts[j + 1] : null);
                var shouldRound = false;
                var radiusToUse = params.radius;

                // Check point validity
                var hasValidNeighbors = (
                    prev &&
                    nxt &&
                    curr &&
                    curr.anchor &&
                    prev.anchor &&
                    nxt.anchor &&
                    curr.leftDirection !== undefined &&
                    curr.rightDirection !== undefined &&
                    curr.kind !== undefined
                );

                if (hasValidNeighbors)
                {
                    switch (params.editMode)
                    {
                        case 0: // Edit All Points
                            shouldRound = true;
                            break;

                        case 1: // Only Corners
                            // (Refined: Geometric Corner + Angle Filter)
                            var isGeomCorner = isGeometricCorner(curr, prev, nxt, sp.closed);
                            if (isGeomCorner)
                            {
                                var angle = calculateAngle(prev.anchor, curr.anchor, nxt.anchor);
                                if (angle >= params.minAngle && angle <= params.maxAngle)
                                {
                                    shouldRound = true;
                                }
                            }
                            break;

                        case 2: // Custom Points
                        case 3: // Custom Corners
                            // In custom modes, the decision to round is based on whether
                            // this point was selected in the UI (params.customRadii).
                            if (
                                params.customRadii &&
                                params.customRadii[currentGlobalIndex] !== undefined
                            )
                            {
                                var customR = params.customRadii[currentGlobalIndex];
                                if (customR > 0)
                                {
                                    shouldRound = true;
                                    radiusToUse = customR;
                                }
                            }
                            break;
                    }

                    // Apply Point Type Filter (only in Edit All and Only Corners modes)
                    if (
                        shouldRound &&
                        (params.editMode === 0 || params.editMode === 1) &&
                        params.pointTypeFilter !== 0
                    )
                    {
                        var pointType = getPointType(prev.anchor, curr.anchor, nxt.anchor);
                        if (params.pointTypeFilter === 1 && pointType !== -1)
                        {
                            shouldRound = false;
                        }
                        else if (params.pointTypeFilter === 2 && pointType !== 1)
                        {
                            shouldRound = false;
                        }
                    }
                }
                else
                {
                    // Is an endpoint or invalid data
                    shouldRound = false;
                }

                // --- Perform Rounding Calculation (Original Formula) ---
                if (shouldRound)
                {
                    if (prev && nxt && curr && curr.anchor && prev.anchor && nxt.anchor)
                    {
                        var v1 = subtractVectors(prev.anchor, curr.anchor);
                        var v2 = subtractVectors(nxt.anchor, curr.anchor);
                        var l1 = vectorLength(v1);
                        var l2 = vectorLength(v2);

                        if (l1 < 1e-6 || l2 < 1e-6)
                        {
                            shouldRound = false;
                        }
                        else
                        {
                            var angleDeg = calculateAngle(prev.anchor, curr.anchor, nxt.anchor);
                            var thetaRad = angleDeg * Math.PI / 180.0;
                            var tanHalfTheta = Math.tan(thetaRad / 2.0);

                            if (Math.abs(tanHalfTheta) < 1e-9 || isNaN(tanHalfTheta))
                            {
                                shouldRound = false;
                            }
                            else
                            {
                                var maxOffsetForRadius = radiusToUse / tanHalfTheta;
                                var offset = Math.min(
                                    Math.abs(maxOffsetForRadius),
                                    l1 / 2.0,
                                    l2 / 2.0
                                );

                                if (offset < 1e-6)
                                {
                                    shouldRound = false;
                                }
                                else
                                {
                                    var normV1 = normalizeVector(v1);
                                    var normV2 = normalizeVector(v2);
                                    var A_anchor = addVectors(curr.anchor, scaleVector(normV1, offset));
                                    var B_anchor = addVectors(curr.anchor, scaleVector(normV2, offset));
                                    var h = (4 / 3) * Math.tan((Math.PI - thetaRad) / 4) *
                                            radiusToUse * (1 - params.flatness);

                                    var pointA = new PathPointInfo();
                                    pointA.anchor = scalePoint(A_anchor, scaleFactor);
                                    pointA.rightDirection = scalePoint(A_anchor, scaleFactor);
                                    pointA.leftDirection = scalePoint(
                                        addVectors(
                                            A_anchor,
                                            scaleVector(
                                                normalizeVector(
                                                    subtractVectors(curr.anchor, A_anchor)
                                                ),
                                                h
                                            )
                                        ),
                                        scaleFactor
                                    );
                                    pointA.kind = PointKind.CORNERPOINT;

                                    var pointB = new PathPointInfo();
                                    pointB.anchor = scalePoint(B_anchor, scaleFactor);
                                    pointB.leftDirection = scalePoint(B_anchor, scaleFactor);
                                    pointB.rightDirection = scalePoint(
                                        addVectors(
                                            B_anchor,
                                            scaleVector(
                                                normalizeVector(
                                                    subtractVectors(curr.anchor, B_anchor)
                                                ),
                                                h
                                            )
                                        ),
                                        scaleFactor
                                    );
                                    pointB.kind = PointKind.CORNERPOINT;

                                    pointProcessingData.push(
                                    {
                                        A: pointA,
                                        B: pointB,
                                        orig: curr.anchor.slice()
                                    });
                                }
                            }
                        }
                    }
                    else
                    {
                        shouldRound = false;
                    }
                }

                // If Not Rounded
                if (!shouldRound)
                {
                    var origCopy = new PathPointInfo();
                    origCopy.anchor = scalePoint(curr.anchor, scaleFactor);
                    origCopy.leftDirection = scalePoint(curr.leftDirection, scaleFactor);
                    origCopy.rightDirection = scalePoint(curr.rightDirection, scaleFactor);
                    origCopy.kind = curr.kind;
                    pointProcessingData.push({ A: origCopy, orig: curr.anchor.slice() });
                }

                globalPointCounter++;
            }

            var reorderedPoints = [];
            var m = pointProcessingData.length;

            if (m > 0)
            {
                for (var k = 0; k < m; k++)
                {
                    reorderedPoints.push(pointProcessingData[k].A);
                    if (pointProcessingData[k].B !== undefined)
                    {
                        reorderedPoints.push(pointProcessingData[k].B);
                    }
                }
            }

            if (reorderedPoints.length > 0)
            {
                var spinfo = new SubPathInfo();
                spinfo.operation = sp.operation;
                spinfo.closed = sp.closed;
                spinfo.entireSubPath = reorderedPoints;
                newSubPaths.push(spinfo);
            }
        }

        if (newSubPaths.length === 0)
        {
            throw new Error("Processing failed: Resulting path would be empty.");
        }

        var originalName = pathItem.name;
        var baseName = originalName.replace(/ \((Original|Rounded|Restored.*)\)( \(\d+\))?$/, '');
        var baseOriginalName = baseName + " (Original)";
        var renamedOriginalName = baseOriginalName;
        var counter = 1;

        while (nameExists(renamedOriginalName))
        {
            renamedOriginalName = baseOriginalName + " (" + counter + ")";
            counter++;
            if (counter > 50)
            {
                renamedOriginalName = baseName + " (Original - Name Conflict " + Date.now() + ")";
                break;
            }
        }

        try
        {
            pathItem.name = renamedOriginalName;
        }
        catch (e) {}

        var baseNewName = baseName + " (Rounded)";
        var newName = baseNewName;
        counter = 1;

        while (nameExists(newName))
        {
            newName = baseNewName + " (" + counter + ")";
            counter++;
            if (counter > 50)
            {
                newName = baseName + " (Rounded - Name Conflict " + Date.now() + ")";
                break;
            }
        }

        try
        {
            var newPath = app.activeDocument.pathItems.add(newName, newSubPaths);
            newPath.select();
        }
        catch (e)
        {
            throw new Error("Failed to create the final rounded path: " + e);
        }
    }

    // --- Vector Math Helpers ---
    function calculateAngle(p0_anchor, p1_anchor, p2_anchor)
    {
        if (!p0_anchor || !p1_anchor || !p2_anchor) return 0;
        var v1 = subtractVectors(p0_anchor, p1_anchor);
        var v2 = subtractVectors(p2_anchor, p1_anchor);
        var l1 = vectorLength(v1);
        var l2 = vectorLength(v2);
        if (l1 < 1e-9 || l2 < 1e-9) return 0;
        var dot = v1[0] * v2[0] + v1[1] * v2[1];
        var cosTheta = dot / (l1 * l2);
        cosTheta = Math.max(-1.0, Math.min(1.0, cosTheta));
        return Math.acos(cosTheta) * 180.0 / Math.PI;
    }

})(); // End of main function wrapper
