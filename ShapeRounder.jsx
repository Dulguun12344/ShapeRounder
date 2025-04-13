/*
    Shape Rounder Tool for Adobe Photoshop
    ========================================
    This script rounds the sharp corners of any selected path or vector shape
    (work path, vector mask, or shape layer) in Photoshop. It now includes the
    ability to round specific points with custom radii via an interactive UI
    with a paginated point list (showing ~3 points per page).

    Fixes:
    - Corrects initial dialog size when Custom Points panel is hidden.
    - Uses pagination to limit the number of point rows visible at any time.
    - Centers Apply/Reset/Cancel buttons horizontally.
    - Prevents dialog height from expanding based on total point count.
*/

// Function to get the name of the currently selected path in the Paths panel
function getSelectedPathName() {
    var ref = new ActionReference();
    ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("PthN"));
    ref.putEnumerated(charIDToTypeID("Path"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    try {
        var desc = executeActionGet(ref);
        if (desc.hasKey(charIDToTypeID("PthN"))) {
            return desc.getString(charIDToTypeID("PthN"));
        } else {
            return null;
        }
    } catch (e) {
        return null;
    }
}

(function main() {
    // ------------------------------
    // Document & Path Check
    // ------------------------------
    if (!app.documents.length) {
        alert("No document open.");
        return;
    }
    var doc = app.activeDocument;
    // Compute a scaling factor so new coordinates match a 72ppi canvas.
    var scaleFactor = 72 / doc.resolution;
    
    var validPaths = [];
    var seenPathSignatures = {}; // key: name + anchorCount

    if (doc.pathItems && doc.pathItems.length > 0) {
        for (var i = 0; i < doc.pathItems.length; i++) {
            var path = doc.pathItems[i];
            if (path && path.kind !== PathKind.CLIPPINGPATH && hasAnchorPoints(path)) {
                var anchorCount = 0;
                for (var s = 0; s < path.subPathItems.length; s++) {
                    anchorCount += path.subPathItems[s].pathPoints.length;
                }
                var sig = path.name + "::" + anchorCount;
                if (!seenPathSignatures[sig]) {
                    validPaths.push(path);
                    seenPathSignatures[sig] = true;
                }
            }
        }
    }
    if (validPaths.length === 0) {
        alert("No valid paths with anchor points found.");
        return;
    }

    var selectedPathName = getSelectedPathName();
    var defaultIndex = 0;
    if (selectedPathName !== null) {
        for (var i = 0; i < validPaths.length; i++) {
            if (validPaths[i].name === selectedPathName) {
                defaultIndex = i;
                break;
            }
        }
    }

    // ------------------------------
    // Global Variables & Defaults
    // ------------------------------
    var defaultParams = {
        radius: 30,
        flatness: 0,
        minAngle: 0,
        maxAngle: 180,
        editMode: 1
    };
    var params = {
        radius: defaultParams.radius,
        flatness: defaultParams.flatness,
        minAngle: defaultParams.minAngle,
        maxAngle: defaultParams.maxAngle,
        editMode: defaultParams.editMode,
        customRadii: []
    };
    var lastUsedGlobalRadius = params.radius; // store current Global Radius
    var action = "cancel";
    var origPathData = null;
    var pointControls = [];

    // Pagination variables for Custom Points list
    var currentPage = 0;
    var itemsPerPage = 5; // default

    function updateItemsPerPage() {
        if (fullPointList.length < 5) {
            itemsPerPage = fullPointList.length;
        } else {
            itemsPerPage = 5;
        }
    }

    var totalPages = 0;
    var fullPointList = []; // holds all point data from the selected path
    var pointSelections = {}; // Key: globalIndex, Value: { selected: bool, radius: number }

    // ------------------------------
    // Helper: Scale a 2-element point by a factor
    function scalePoint(pt, factor) {
        return [pt[0] * factor, pt[1] * factor];
    }
    
    // ------------------------------
    // Build the ScriptUI Panel
    // ------------------------------
    var dlg = new Window("dialog", "Shape Rounder Tool");
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.margins = 15;
    dlg.spacing = 10;

    // --- Path Selection ---
    var pathGroup = dlg.add("group");
    pathGroup.alignment = ["fill", "top"];
    pathGroup.add("statictext", undefined, "Select Path:");
    var pathNames = [];
    for (var i = 0; i < validPaths.length; i++) {
        pathNames.push(validPaths[i].name || ("(Path " + i + ")"));
    }
    var pathDropdown = pathGroup.add("dropdownlist", undefined, pathNames);
    pathDropdown.selection = defaultIndex;
    pathDropdown.preferredSize.width = 250;

    // --- Round Mode Selection ---
    var modeGroup = dlg.add("group");
    modeGroup.alignment = ["fill", "top"];
    modeGroup.add("statictext", undefined, "Round Mode:");
    var editModeDropdown = modeGroup.add("dropdownlist", undefined, ["Edit All Points", "Only Corners", "Custom Points"]);
    editModeDropdown.selection = 0; // Force "Edit All Points"
    params.editMode = 0;
    editModeDropdown.preferredSize.width = 250;

    // --- Panel for Global/Angle Settings ---
    var settingsPanel = dlg.add("panel", undefined, "Settings");
    settingsPanel.orientation = "column";
    settingsPanel.alignChildren = ["fill", "top"];
    settingsPanel.margins = [10, 15, 10, 10];
    settingsPanel.spacing = 8;

    var radiusGroup = settingsPanel.add("group");
    radiusGroup.add("statictext", undefined, "Global Radius (px):");
    var radiusInput = radiusGroup.add("edittext", undefined, params.radius.toString());
    radiusInput.characters = 6;

    var flatnessGroup = settingsPanel.add("group");
    flatnessGroup.add("statictext", undefined, "Flatness (%):");
    var flatnessInput = flatnessGroup.add("edittext", undefined, (params.flatness * 100).toString());
    flatnessInput.characters = 6;

    var grpMin = settingsPanel.add("group");
    grpMin.orientation = "row";
    grpMin.add("statictext", undefined, "Min Angle (°):");
    var minAngleSlider = grpMin.add("slider", undefined, params.minAngle, 0, 180);
    minAngleSlider.preferredSize.width = 150;
    var minAngleLabel = grpMin.add("statictext", undefined, params.minAngle.toString());
    minAngleLabel.characters = 4;
    minAngleSlider.onChanging = function() {
        minAngleLabel.text = Math.round(this.value);
    };

    var grpMax = settingsPanel.add("group");
    grpMax.orientation = "row";
    grpMax.add("statictext", undefined, "Max Angle (°):");
    var maxAngleSlider = grpMax.add("slider", undefined, params.maxAngle, 0, 180);
    maxAngleSlider.preferredSize.width = 150;
    var maxAngleLabel = grpMax.add("statictext", undefined, params.maxAngle.toString());
    maxAngleLabel.characters = 4;
    maxAngleSlider.onChanging = function() {
        maxAngleLabel.text = Math.round(this.value);
    };

    // --- Container Group for Custom Points Panel ---
    var customPointsContainer = dlg.add("group");
    customPointsContainer.orientation = "column";
    customPointsContainer.alignChildren = ["fill", "fill"];
    customPointsContainer.margins = 0;
    customPointsContainer.spacing = 0;
    customPointsContainer.visible = false; // Start hidden

    // --- Panel for Custom Points List ---
    // (The panel height is fixed so that only ~3 rows show.)
    var pointScrollPanel = customPointsContainer.add("panel", undefined, "Custom Points");
    pointScrollPanel.alignChildren = ["fill", "top"];
    pointScrollPanel.margins = [10, 15, 10, 10];
    pointScrollPanel.spacing = 5;
    pointScrollPanel.preferredSize.height = 100;

    // --- Group inside the Custom Points Panel to hold point controls ---
    var pointGroup = pointScrollPanel.add("group");
    pointGroup.orientation = "column";
    pointGroup.alignChildren = ["fill", "top"];

    // --- Pagination Buttons ---
    var paginationGroup = customPointsContainer.add("group");
    paginationGroup.orientation = "row";
    paginationGroup.alignment = ["center", "top"];
    paginationGroup.spacing = 10;
    var prevBtn = paginationGroup.add("button", undefined, "Previous");
    var nextBtn = paginationGroup.add("button", undefined, "Next");

    prevBtn.onClick = function () {
        if (currentPage > 0) {
            currentPage--;
            renderCurrentPage();
        }
    };
    nextBtn.onClick = function () {
        if (currentPage < totalPages - 1) {
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
    resetBtn.helpTip = "Resets dialog fields";
    var cancelBtn = btns.add("button", undefined, "Cancel", { name: "cancel" });

    // --- Helper Functions ---
    function renderCurrentPage() {
        // Save current states before re-rendering
        for (var i = 0; i < pointControls.length; i++) {
            var ctrl = pointControls[i];
            pointSelections[ctrl.globalIndex] = {
                selected: ctrl.checkbox.value,
                radius: parseFloat(ctrl.input.text) || defaultParams.radius
            };
        }
        // Clear UI
        while (pointGroup.children.length > 0) {
            pointGroup.remove(pointGroup.children[0]);
        }
        pointControls = [];

        var start = currentPage * itemsPerPage;
        var end = Math.min(start + itemsPerPage, fullPointList.length);

        if (fullPointList.length === 0) {
            pointGroup.add("statictext", undefined, "No points found.");
        } else {
            for (var i = start; i < end; i++) {
                var ptData = fullPointList[i];
                var row = pointGroup.add("group");
                row.orientation = "row";
                row.alignment = ["fill", "top"];
                row.spacing = 5;

                var chk = row.add("checkbox", undefined, "");
                chk.helpTip = "Round point " + ptData.globalIndex;

                var label = row.add("statictext", undefined, "P" + ptData.globalIndex + ": [" + ptData.anchor[0].toFixed(1) + ", " + ptData.anchor[1].toFixed(1) + "]");
                label.preferredSize.width = 180;

                var pointRadiusInput = row.add("edittext", undefined, lastUsedGlobalRadius.toString());
                pointRadiusInput.characters = 5;
                pointRadiusInput.enabled = false;
                pointRadiusInput.helpTip = "Radius for point " + ptData.globalIndex;

                var stored = pointSelections[ptData.globalIndex];
                if (stored) {
                    chk.value = stored.selected;
                    pointRadiusInput.text = stored.radius.toString();
                    pointRadiusInput.enabled = stored.selected;
                }

                chk.onClick = (function(inputField) {
                    return function() {
                        inputField.enabled = this.value;
                    };
                })(pointRadiusInput);

                pointControls.push({
                    globalIndex: ptData.globalIndex,
                    subpathIndex: ptData.subpathIndex,
                    pointIndex: ptData.pointIndex,
                    checkbox: chk,
                    input: pointRadiusInput
                });
            }
        }

        var displayed = end - start;
        var missing = itemsPerPage - displayed;
        for (var i = 0; i < missing; i++) {
            var dummy = pointGroup.add("group");
            dummy.orientation = "row";
            dummy.alignment = ["fill", "top"];
            dummy.spacing = 5;

            var emptyCheckbox = dummy.add("checkbox", undefined, "");
            emptyCheckbox.enabled = false;
            emptyCheckbox.visible = false;

            var emptyLabel = dummy.add("statictext", undefined, "");
            emptyLabel.preferredSize.width = 180;

            var emptyInput = dummy.add("edittext", undefined, "");
            emptyInput.characters = 5;
            emptyInput.enabled = false;
            emptyInput.visible = false;
        }

        prevBtn.enabled = (currentPage > 0);
        nextBtn.enabled = (currentPage < totalPages - 1);
        var showNav = (totalPages > 1);
        prevBtn.visible = showNav;
        nextBtn.visible = showNav;

        dlg.layout.layout(true);
    }

    function populatePointList(pathItem) {
        fullPointList = [];
        pointControls = [];
        var globalPointIndex = 0;
        if (pathItem && pathItem.subPathItems) {
            for (var s = 0; s < pathItem.subPathItems.length; s++) {
                var sp = pathItem.subPathItems[s];
                if (sp && sp.pathPoints) {
                    for (var p = 0; p < sp.pathPoints.length; p++) {
                        var anchorPt = sp.pathPoints[p];
                        if (anchorPt && anchorPt.anchor) {
                            // Use the original coordinate (no scaling in UI display)
                            fullPointList.push({
                                globalIndex: globalPointIndex,
                                subpathIndex: s,
                                pointIndex: p,
                                anchor: anchorPt.anchor.slice()
                            });
                            globalPointIndex++;
                        }
                    }
                }
            }
        } else {
            while (pointGroup.children.length > 0) {
                pointGroup.remove(pointGroup.children[0]);
            }
            pointGroup.add("statictext", undefined, "Error.");
            return;
        }
        updateItemsPerPage();
        totalPages = Math.ceil(fullPointList.length / itemsPerPage);
        currentPage = 0;
        renderCurrentPage();
    }

    function updateUIMode() {
        var mode = editModeDropdown.selection.index;
        radiusInput.parent.enabled = (mode !== 2);
        flatnessInput.parent.enabled = true;
        grpMin.enabled = (mode === 1);
        grpMax.enabled = (mode === 1);
        if (mode === 2) {
            // Save the last used Global Radius
            lastUsedGlobalRadius = parseFloat(radiusInput.text) || defaultParams.radius;
        }
        customPointsContainer.visible = (mode === 2);
        if (mode === 2 && validPaths.length > 0 && pathDropdown.selection !== null) {
            var idx = pathDropdown.selection.index;
            if (idx >= 0 && idx < validPaths.length) {
                populatePointList(validPaths[idx]);
            }
        } else {
            while (pointGroup.children.length > 0) {
                pointGroup.remove(pointGroup.children[0]);
            }
            pointControls = [];
            pointGroup.add("statictext", undefined, "Select Custom Points mode to view points.");
            dlg.layout.layout(true);
        }
        dlg.layout.layout(true);
    }

    pointGroup.add("statictext", undefined, "Select Custom Points mode to view points.");
    updateUIMode();
    dlg.layout.layout(true);
    dlg.layout.resize();

    pathDropdown.onChange = function() {
        if (this.selection !== null) {
            var idx = this.selection.index;
            if (idx >= 0 && idx < validPaths.length && editModeDropdown.selection.index === 2) {
                populatePointList(validPaths[idx]);
            }
        }
    };

    editModeDropdown.onChange = updateUIMode;

    resetBtn.onClick = function() {
        radiusInput.text = defaultParams.radius.toString();
        flatnessInput.text = (defaultParams.flatness * 100).toString();
        minAngleSlider.value = defaultParams.minAngle;
        minAngleLabel.text = defaultParams.minAngle.toString();
        maxAngleSlider.value = defaultParams.maxAngle;
        maxAngleLabel.text = defaultParams.maxAngle.toString();
        editModeDropdown.selection = 0;
        params.editMode = 0;
        for (var i = 0; i < pointControls.length; i++) {
            pointControls[i].checkbox.value = false;
            pointControls[i].input.text = defaultParams.radius.toString();
            pointControls[i].input.enabled = false;
        }
        updateUIMode();
    };

    applyBtn.onClick = function() {
        // Save current page selections before applying
        for (var i = 0; i < pointControls.length; i++) {
            var ctrl = pointControls[i];
            pointSelections[ctrl.globalIndex] = {
                selected: ctrl.checkbox.value,
                radius: parseFloat(ctrl.input.text) || defaultParams.radius
            };
        }
        action = "apply";
        var selectedIndex = pathDropdown.selection.index;
        if (selectedIndex < 0 || selectedIndex >= validPaths.length) {
            alert("No valid path selected.");
            action = "cancel";
            return;
        }
        var selectedPath = validPaths[selectedIndex];
        try {
            origPathData = duplicatePathData(selectedPath);
            if (!origPathData || !hasPointsDeep(origPathData)) {
                throw new Error("Backup fail/empty.");
            }
        } catch (e) {
            alert("Backup failed: " + e);
            action = "cancel";
            return;
        }
        params.radius = parseFloat(radiusInput.text) || 0;
        params.flatness = (parseFloat(flatnessInput.text) || 0) / 100.0;
        params.minAngle = minAngleSlider.value;
        params.maxAngle = maxAngleSlider.value;
        params.editMode = editModeDropdown.selection.index;
        params.customRadii = [];
        if (params.editMode === 2) {
            for (var key in pointSelections) {
                if (pointSelections.hasOwnProperty(key)) {
                    if (pointSelections[key].selected) {
                        params.customRadii[key] = pointSelections[key].radius;
                    }
                }
            }
        }
        dlg.close();
    };

    cancelBtn.onClick = function() {
        action = "cancel";
        dlg.close();
    };

    dlg.center();
    dlg.show();

    if (action === "apply") {
        var selectedIndex = pathDropdown.selection.index;
        if (selectedIndex >= 0 && selectedIndex < validPaths.length) {
            var finalSelectedPath = validPaths[selectedIndex];
            try {
                processPath(finalSelectedPath, params);
            } catch (e) {
                alert("Error processing path: " + e);
                if (origPathData) {
                    try {
                        var pathPossiblyRenamed = findPathPotentiallyRenamed(finalSelectedPath.name);
                        if (pathPossiblyRenamed) {
                            restorePath(pathPossiblyRenamed, origPathData);
                        } else {
                            alert("Error & failed auto-restore.");
                        }
                    } catch (restoreError) {
                        alert("Error & failed restore: " + restoreError);
                    }
                }
            }
        } else {
            alert("Internal error: Invalid path index.");
        }
    }

    function hasAnchorPoints(pathItem) {
        if (!pathItem || !pathItem.subPathItems || pathItem.subPathItems.length < 1) return false;
        try {
            for (var i = 0; i < pathItem.subPathItems.length; i++) {
                var sp = pathItem.subPathItems[i];
                if (sp && sp.pathPoints && sp.pathPoints.length > 0) {
                    return true;
                }
            }
        } catch (e) {
            return false;
        }
        return false;
    }

    function hasPointsDeep(backupData) {
        if (!backupData || backupData.length === 0) return false;
        for (var i = 0; i < backupData.length; i++) {
            if (backupData[i] && backupData[i].points && backupData[i].points.length > 0) {
                return true;
            }
        }
        return false;
    }

    function findPathPotentiallyRenamed(originalBaseName) {
        var baseOriginal = originalBaseName.replace(/ \((Original|Rounded|Restored \d+)\)( \(\d+\))?$/, '') + " (Original)";
        try {
            return app.activeDocument.pathItems.getByName(baseOriginal);
        } catch (e) {}
        var i = 1;
        while (true) {
            var numberedName = baseOriginal + " (" + i + ")";
            try {
                return app.activeDocument.pathItems.getByName(numberedName);
            } catch (e) {}
            if (i > 50) break;
            i++;
        }
        try {
            return app.activeDocument.pathItems.getByName(originalBaseName);
        } catch (e) {}
        return null;
    }

    function nameExists(name) {
        try {
            app.activeDocument.pathItems.getByName(name);
            return true;
        } catch (e) {
            return false;
        }
    }

    function duplicatePathData(pathItem) {
        if (!hasAnchorPoints(pathItem)) {
            return [];
        }
        var subPaths = [];
        try {
            for (var i = 0; i < pathItem.subPathItems.length; i++) {
                var sp = pathItem.subPathItems[i];
                if (!sp || !sp.pathPoints) continue;
                var pts = [];
                for (var j = 0; j < sp.pathPoints.length; j++) {
                    var p = sp.pathPoints[j];
                    if (p && p.anchor && p.leftDirection && p.rightDirection && p.kind !== undefined) {
                        // Do not scale backup data; keep the original coordinates.
                        pts.push({
                            anchor: p.anchor.slice(),
                            leftDirection: p.leftDirection.slice(),
                            rightDirection: p.rightDirection.slice(),
                            kind: p.kind
                        });
                    }
                }
                if (pts.length > 0) {
                    subPaths.push({
                        operation: sp.operation,
                        closed: sp.closed,
                        points: pts
                    });
                }
            }
        } catch (e) {
            throw e;
        }
        return subPaths;
    }

    function restorePath(pathItemToReplace, backupData) {
        var originalName = pathItemToReplace.name;
        if (!backupData || !hasPointsDeep(backupData)) {
            throw new Error("Bad backup.");
        }
        var newSubPaths = [];
        for (var i = 0; i < backupData.length; i++) {
            if (!backupData[i] || !backupData[i].points || backupData[i].points.length === 0) continue;
            var spinfo = new SubPathInfo();
            spinfo.operation = backupData[i].operation;
            spinfo.closed = backupData[i].closed;
            var arrPts = [];
            for (var j = 0; j < backupData[i].points.length; j++) {
                var data = backupData[i].points[j];
                if (!data || !data.anchor || !data.leftDirection || !data.rightDirection || data.kind === undefined) continue;
                var pinfo = new PathPointInfo();
                pinfo.anchor = data.anchor.slice();
                pinfo.leftDirection = data.leftDirection.slice();
                pinfo.rightDirection = data.rightDirection.slice();
                pinfo.kind = data.kind;
                arrPts.push(pinfo);
            }
            if (arrPts.length > 0) {
                spinfo.entireSubPath = arrPts;
                newSubPaths.push(spinfo);
            }
        }
        if (newSubPaths.length === 0) {
            throw new Error("No valid subpaths from backup.");
        }
        var tempPathFocus = null;
        try {
            try {
                pathItemToReplace.deselect();
            } catch (e) {}
            tempPathFocus = app.activeDocument.pathItems.add("TempR", []);
            tempPathFocus.select();
            pathItemToReplace.remove();
        } catch (e) {
            throw new Error("Failed remove: " + e);
        } finally {
            try {
                if (tempPathFocus) tempPathFocus.remove();
            } catch (e2) {}
        }
        var restoredBaseName = originalName.replace(/ \((Original|Rounded|Restored \d+)\)( \(\d+\))?$/, '');
        var finalRestoredName = restoredBaseName;
        var counter = 1;
        while (nameExists(finalRestoredName)) {
            finalRestoredName = restoredBaseName + " (Restored " + counter + ")";
            counter++;
        }
        var restoredPath = app.activeDocument.pathItems.add(finalRestoredName, newSubPaths);
        restoredPath.select();
    }

    function processPath(pathItem, params) {
        var newSubPaths = [];
        var globalPointCounter = 0;
        for (var i = 0; i < pathItem.subPathItems.length; i++) {
            var sp = pathItem.subPathItems[i];
            var pts = sp.pathPoints;
            var len = pts.length;
            var pointProcessingData = [];
            if ((len < 2 && !sp.closed) || (len < 3 && sp.closed)) {
                var originalPoints = [];
                for (var k = 0; k < len; k++) {
                    var p = pts[k];
                    var pinfo = new PathPointInfo();
                    // Scale non-rounded point coordinates.
                    pinfo.anchor = scalePoint(p.anchor.slice(), scaleFactor);
                    pinfo.leftDirection = scalePoint(p.leftDirection.slice(), scaleFactor);
                    pinfo.rightDirection = scalePoint(p.rightDirection.slice(), scaleFactor);
                    pinfo.kind = p.kind;
                    originalPoints.push(pinfo);
                }
                var spinfoCopy = new SubPathInfo();
                spinfoCopy.operation = sp.operation;
                spinfoCopy.closed = sp.closed;
                spinfoCopy.entireSubPath = originalPoints;
                newSubPaths.push(spinfoCopy);
                globalPointCounter += len;
                continue;
            }
            for (var j = 0; j < len; j++) {
                var curr = pts[j];
                var prev = pts[(j - 1 + len) % len];
                var nxt = pts[(j + 1) % len];

                if (!sp.closed && (j === 0 || j === len - 1)) {
                    var origCopy = new PathPointInfo();
                    origCopy.anchor = scalePoint(curr.anchor.slice(), scaleFactor);
                    origCopy.leftDirection = scalePoint(curr.leftDirection.slice(), scaleFactor);
                    origCopy.rightDirection = scalePoint(curr.rightDirection.slice(), scaleFactor);
                    origCopy.kind = curr.kind;
                    pointProcessingData.push({ A: origCopy, orig: curr.anchor.slice() });
                    continue;
                }
                var angle = calculateAngle(prev.anchor, curr.anchor, nxt.anchor);
                var shouldRound = false;
                var radiusToUse = params.radius;
                switch (params.editMode) {
                    case 0:
                        shouldRound = true;
                        break;
                    case 1:
                        if (angle >= params.minAngle && angle <= params.maxAngle) {
                            shouldRound = true;
                        }
                        break;
                    case 2:
                        var globalIndex = globalPointCounter;
                        if (params.customRadii && params.customRadii[globalIndex] !== undefined) {
                            var customR = params.customRadii[globalIndex];
                            if (customR > 0) {
                                shouldRound = true;
                                radiusToUse = customR;
                            }
                        }
                        break;
                }
                if (shouldRound) {
                    var v1 = subtractVectors(prev.anchor, curr.anchor);
                    var v2 = subtractVectors(nxt.anchor, curr.anchor);
                    var l1 = vectorLength(v1);
                    var l2 = vectorLength(v2);
                    if (l1 < 1e-6 || l2 < 1e-6) {
                        shouldRound = false;
                    } else {
                        var thetaRad = angle * Math.PI / 180;
                        var maxOffset = (Math.tan(thetaRad / 2) > 1e-9)
                            ? (radiusToUse / Math.tan(thetaRad / 2))
                            : radiusToUse * 1e9;
                        var offset = Math.min(maxOffset, l1 / 2, l2 / 2);
                        if (offset < 1e-6) {
                            shouldRound = false;
                        } else {
                            var normV1 = normalizeVector(v1);
                            var normV2 = normalizeVector(v2);
                            var A_anchor = addVectors(curr.anchor, scaleVector(normV1, offset));
                            var B_anchor = addVectors(curr.anchor, scaleVector(normV2, offset));
                            var h = (4 / 3) * Math.tan((Math.PI - thetaRad) / 4) * radiusToUse * (1 - params.flatness);

                            var pointA = new PathPointInfo();
                            // Scale computed coordinates for pointA.
                            pointA.anchor = scalePoint(A_anchor, scaleFactor);
                            pointA.rightDirection = scalePoint(A_anchor, scaleFactor);
                            pointA.leftDirection = scalePoint(addVectors(A_anchor, scaleVector(normalizeVector(subtractVectors(curr.anchor, A_anchor)), h)), scaleFactor);
                            pointA.kind = PointKind.CORNERPOINT;

                            var pointB = new PathPointInfo();
                            pointB.anchor = scalePoint(B_anchor, scaleFactor);
                            pointB.rightDirection = scalePoint(addVectors(B_anchor, scaleVector(normalizeVector(subtractVectors(curr.anchor, B_anchor)), h)), scaleFactor);
                            pointB.leftDirection = scalePoint(B_anchor, scaleFactor);
                            pointB.kind = PointKind.CORNERPOINT;

                            pointProcessingData.push({ A: pointA, B: pointB, orig: curr.anchor.slice() });
                        }
                    }
                }
                if (!shouldRound) {
                    var origCopy = new PathPointInfo();
                    origCopy.anchor = scalePoint(curr.anchor.slice(), scaleFactor);
                    origCopy.leftDirection = scalePoint(curr.leftDirection.slice(), scaleFactor);
                    origCopy.rightDirection = scalePoint(curr.rightDirection.slice(), scaleFactor);
                    origCopy.kind = curr.kind;
                    pointProcessingData.push({ A: origCopy, orig: curr.anchor.slice() });
                }
                globalPointCounter++;
            }

            var reorderedPoints = [];
            var m = pointProcessingData.length;
            if (m > 0) {
                for (var k = 0; k < m; k++) {
                    reorderedPoints.push(pointProcessingData[k].A);
                    if (pointProcessingData[k].B !== undefined) {
                        reorderedPoints.push(pointProcessingData[k].B);
                    }
                }
            }
            if (reorderedPoints.length > 0) {
                var spinfo = new SubPathInfo();
                spinfo.operation = sp.operation;
                spinfo.closed = sp.closed;
                spinfo.entireSubPath = reorderedPoints;
                newSubPaths.push(spinfo);
            }
            globalPointCounter += len;
        }

        if (newSubPaths.length === 0) {
            throw new Error("No valid subpaths.");
        }

        var originalName = pathItem.name;
        var baseName = originalName.replace(/ \((Original|Rounded|Restored \d+)\)( \(\d+\))?$/, '');
        var baseOriginalName = baseName + " (Original)";
        var renamedOriginalName = baseOriginalName;
        var counter = 1;
        while (nameExists(renamedOriginalName)) {
            renamedOriginalName = baseOriginalName + " (" + counter + ")";
            counter++;
        }
        try {
            pathItem.name = renamedOriginalName;
        } catch (e) {
        }

        var baseNewName = baseName + " (Rounded)";
        var newName = baseNewName;
        counter = 1;
        while (nameExists(newName)) {
            newName = baseNewName + " (" + counter + ")";
            counter++;
        }
        try {
            var newPath = app.activeDocument.pathItems.add(newName, newSubPaths);
            newPath.select();
        } catch (e) {
            throw e;
        }
    }

    function vectorLength(v) {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    }

    function normalizeVector(v) {
        var l = vectorLength(v);
        if (l < 1e-9) return [0, 0];
        return [v[0] / l, v[1] / l];
    }

    function scaleVector(v, s) {
        return [v[0] * s, v[1] * s];
    }

    function addVectors(a, b) {
        return [a[0] + b[0], a[1] + b[1]];
    }

    function subtractVectors(a, b) {
        return [a[0] - b[0], a[1] - b[1]];
    }

    function calculateAngle(p0, p1, p2) {
        if (!p0 || !p1 || !p2 || p0.length !== 2 || p1.length !== 2 || p2.length !== 2) {
            return 0;
        }
        var v1 = subtractVectors(p0, p1);
        var v2 = subtractVectors(p2, p1);
        var l1 = vectorLength(v1);
        var l2 = vectorLength(v2);
        if (l1 < 1e-9 || l2 < 1e-9) return 0;
        var dot = v1[0] * v2[0] + v1[1] * v2[1];
        var cosTheta = dot / (l1 * l2);
        cosTheta = Math.max(-1, Math.min(1, cosTheta));
        return Math.acos(cosTheta) * 180 / Math.PI;
    }
})();
