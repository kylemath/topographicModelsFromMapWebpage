import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';
import { _3MFExporter } from '3MFExporter';

// Initialize the map
const map = L.map('map').setView([53.5444, -113.4909], 13);

// Add the OpenStreetMap tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Feature group to store drawn layers
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// Draw control
const drawControl = new L.Control.Draw({
    draw: {
        polygon: false,
        polyline: false,
        circle: false,
        marker: false,
        circlemarker: false,
        rectangle: {
            shapeOptions: {
                color: '#ff7800'
            }
        }
    },
    edit: {
        featureGroup: drawnItems
    }
});
map.addControl(drawControl);

// Handle draw:created event
map.on(L.Draw.Event.CREATED, function (event) {
    const layer = event.layer;
    drawnItems.addLayer(layer);

    const bounds = layer.getBounds();
    console.log('Selected area bounds:', bounds);
    fetchOsmData(bounds);
});

function fetchOsmData(bounds) {
    const overpassUrl = 'https://overpass-api.de/api/interpreter';
    const s = bounds.getSouth();
    const w = bounds.getWest();
    const n = bounds.getNorth();
    const e = bounds.getEast();

    const query = `
        [out:json];
        (
            way[building](${s},${w},${n},${e});
            relation[building](${s},${w},${n},${e});
            way[highway](${s},${w},${n},${e});
            way[leisure=park](${s},${w},${n},${e});
            relation[leisure=park](${s},${w},${n},${e});
            way[natural=water](${s},${w},${n},${e});
            relation[natural=water](${s},${w},${n},${e});
            way[natural=sand](${s},${w},${n},${e});
            relation[natural=sand](${s},${w},${n},${e});
        );
        (._;>;);
        out;
    `;

    fetch(overpassUrl, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query)
    })
    .then(response => response.json())
    .then(data => {
        console.log('OpenStreetMap data:', data);
        generateModel(data, bounds);
    })
    .catch(error => {
        console.error('Error fetching OpenStreetMap data:', error);
    });
}

function generateModel(data, bounds) {
    // Clear existing objects from the scene
    const oldModelGroup = scene.getObjectByName("modelGroup");
    if (oldModelGroup) {
        scene.remove(oldModelGroup);
    }

    const modelGroup = new THREE.Group();
    modelGroup.name = "modelGroup";
    scene.add(modelGroup);

    const nodes = {};
    data.elements.forEach(el => {
        if (el.type === 'node') {
            nodes[el.id] = el;
        }
    });

    const centerLat = (bounds.getSouth() + bounds.getNorth()) / 2;
    const centerLon = (bounds.getWest() + bounds.getEast()) / 2;

    function latLonToVector3(lat, lon) {
        const x = -(lon - centerLon) * 111320 * Math.cos(lat * Math.PI / 180); // longitude to meters, negated to fix mirror
        const z = -(lat - centerLat) * 110574; // latitude to meters, negated to match map orientation
        return new THREE.Vector3(x, 0, z); // y is up
    }

    const sw = latLonToVector3(bounds.getSouth(), bounds.getWest());
    const ne = latLonToVector3(bounds.getNorth(), bounds.getEast());
    const modelWidth = ne.x - sw.x;
    const modelDepth = sw.z - ne.z;

    const modelSizeMM = document.getElementById('model-size').value || 200;
    const horizontalMaxDim = Math.max(modelWidth, modelDepth);
    const sceneScale = horizontalMaxDim / parseFloat(modelSizeMM);

    // Use a display scale that makes layers clearly visible in the preview
    const displayVerticalScale = horizontalMaxDim / 50; // Makes layers proportional to model size
    
    // Define heights in scene units for display
    const baseHeight = 0.6 * displayVerticalScale;
    const waterY = baseHeight + (0.1 * displayVerticalScale); // Moved down to be below grass
    const roadY = baseHeight + (0.6 * displayVerticalScale); // Increased to be above grass
    const grassY = baseHeight + (0.2 * displayVerticalScale);

    // Create a base
    const baseGeometry = new THREE.BoxGeometry(modelWidth, baseHeight, modelDepth);
    const baseMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
    baseMesh.position.y = baseHeight / 2;
    baseMesh.userData.originalHeight = 0.6; // Store original height for export
    modelGroup.add(baseMesh);
    
    // Create water plane
    const waterGeometry = new THREE.PlaneGeometry(modelWidth, modelDepth);
    const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x2196F3, side: THREE.DoubleSide }); // Blue water
    const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = waterY;
    waterMesh.userData.originalHeight = 0.1; // Updated to match new position
    modelGroup.add(waterMesh);

    const boundsPolygon = [
        new THREE.Vector3(sw.x, 0, sw.z),
        new THREE.Vector3(ne.x, 0, sw.z),
        new THREE.Vector3(ne.x, 0, ne.z),
        new THREE.Vector3(sw.x, 0, ne.z)
    ];

    // Pre-process to calculate building heights
    const buildingElements = data.elements.filter(el => el.type === 'way' && el.tags && el.tags.building);
    let minBuildingHeightInMeters = Infinity;
    let maxBuildingHeightInMeters = 0;

    buildingElements.forEach(el => {
        let height;
        if (el.tags.height) {
            const parsedHeight = parseFloat(el.tags.height);
            if (!isNaN(parsedHeight)) height = parsedHeight;
        } else if (el.tags['building:levels']) {
            const parsedLevels = parseFloat(el.tags['building:levels']);
            if (!isNaN(parsedLevels)) height = parsedLevels * 3;
        }
        
        if (height === undefined) height = 5; // default
        
        el.calculatedHeight = height;
        
        if (height > 0) {
            if (height < minBuildingHeightInMeters) minBuildingHeightInMeters = height;
            if (height > maxBuildingHeightInMeters) maxBuildingHeightInMeters = height;
        }
    });

    const minPrintHeightMM = 0.8;
    const maxPrintHeightMM = 8.0; // Reduced max height for better proportions

    data.elements.forEach(el => {
        if (el.type === 'way') {
            const points = el.nodes.map(nodeId => {
                const node = nodes[nodeId];
                if (node) {
                    return latLonToVector3(node.lat, node.lon);
                }
                return null;
            }).filter(p => p);

            if (points.length < 2) return;

            if (el.tags && el.tags.building) {
                const shape = new THREE.Shape();
                shape.moveTo(points[0].x, points[0].z);
                for (let i = 1; i < points.length; i++) {
                    shape.lineTo(points[i].x, points[i].z);
                }
                shape.closePath();

                let buildingPrintHeightMM = minPrintHeightMM;
                if (el.calculatedHeight && maxBuildingHeightInMeters > minBuildingHeightInMeters) {
                    const heightRatio = (el.calculatedHeight - minBuildingHeightInMeters) / (maxBuildingHeightInMeters - minBuildingHeightInMeters);
                    buildingPrintHeightMM = minPrintHeightMM + heightRatio * (maxPrintHeightMM - minPrintHeightMM);
                }
                
                // Ensure minimum height and reasonable scaling
                buildingPrintHeightMM = Math.max(minPrintHeightMM, Math.min(maxPrintHeightMM, buildingPrintHeightMM));
                
                const displayBuildingHeight = buildingPrintHeightMM * displayVerticalScale;
                
                const extrudeSettings = {
                    steps: 1,
                    depth: displayBuildingHeight,
                    bevelEnabled: false,
                };

                const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
                const material = new THREE.MeshStandardMaterial({ color: 0x888888 }); // Grey buildings
                const mesh = new THREE.Mesh(geometry, material);
                mesh.rotation.x = -Math.PI / 2;
                mesh.position.y = baseHeight;
                mesh.userData.originalHeight = buildingPrintHeightMM;
                modelGroup.add(mesh);
            } else if (el.tags && el.tags.highway) {
                const clippedLines = clipPolyline(points, boundsPolygon);
                clippedLines.forEach(linePoints => {
                    if (linePoints.length < 2) return;
                    
                    // Create road as thick line segments for better reliability
                    const roadWidth = 1.0 * displayVerticalScale;
                    const roadHeight = 0.2 * displayVerticalScale;
                    
                    for (let i = 0; i < linePoints.length - 1; i++) {
                        const start = linePoints[i];
                        const end = linePoints[i + 1];
                        const distance = start.distanceTo(end);
                        
                        if (distance > 0.1) { // Only create segments for meaningful distances
                            const roadGeometry = new THREE.BoxGeometry(distance, roadHeight, roadWidth);
                            const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x222222 }); // Black roads
                            const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
                            
                            const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
                            roadMesh.position.copy(midpoint);
                            roadMesh.position.y = roadY;
                            
                            const direction = new THREE.Vector3().subVectors(end, start);
                            roadMesh.lookAt(midpoint.clone().add(direction));
                            roadMesh.rotateY(Math.PI / 2);
                            
                            roadMesh.userData.originalHeight = 0.6;
                            modelGroup.add(roadMesh);
                        }
                    }
                });
            } else if (el.tags && (el.tags.leisure === 'park' || el.tags.natural === 'sand')) {
                const clippedPoints = clipPolygon(points, boundsPolygon);
                if (clippedPoints.length < 3) return;

                const shape = new THREE.Shape();
                shape.moveTo(clippedPoints[0].x, clippedPoints[0].z);
                for (let i = 1; i < clippedPoints.length; i++) {
                    shape.lineTo(clippedPoints[i].x, clippedPoints[i].z);
                }
                shape.closePath();

                let color, featureHeightMM;
                switch (el.tags.natural || el.tags.leisure) {
                    case 'sand': color = 0xf4e4bc; featureHeightMM = 0.1; break;
                    case 'park': color = 0x4CAF50; featureHeightMM = 0.2; break; // Green parks
                    default: color = 0x4CAF50; featureHeightMM = 0.2; // Default to green for yards
                }

                if (featureHeightMM > 0) {
                    const displayFeatureHeight = featureHeightMM * displayVerticalScale;
                    const extrudeSettings = {
                        steps: 1,
                        depth: displayFeatureHeight,
                        bevelEnabled: false,
                    };
                    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
                    const material = new THREE.MeshStandardMaterial({ color: color });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.rotation.x = -Math.PI / 2;
                    mesh.position.y = grassY;
                    mesh.userData.originalHeight = featureHeightMM;
                    modelGroup.add(mesh);
                }
            }
        }
    });

    const box = new THREE.Box3().setFromObject(modelGroup);
    fitCameraToBox(box, camera);

    // Center the model for export
    const center = box.getCenter(new THREE.Vector3());
    modelGroup.position.x -= center.x;
    modelGroup.position.z -= center.z;
    modelGroup.position.y -= box.min.y;
}

function clipPolygon(subjectPolygon, clipPolygon) {
    let newPolygon = subjectPolygon;
    for (let i = 0; i < clipPolygon.length; i++) {
        const clipEdgeStart = clipPolygon[i];
        const clipEdgeEnd = clipPolygon[(i + 1) % clipPolygon.length];
        
        const inputList = newPolygon;
        newPolygon = [];
        
        if (inputList.length === 0) {
            break;
        }

        let S = inputList[inputList.length - 1];
        for (let j = 0; j < inputList.length; j++) {
            let E = inputList[j];
            let sInside = isInside(S, clipEdgeStart, clipEdgeEnd);
            let eInside = isInside(E, clipEdgeStart, clipEdgeEnd);

            if (eInside) {
                if (!sInside) {
                    const I = intersection(S, E, clipEdgeStart, clipEdgeEnd);
                    newPolygon.push(I);
                }
                newPolygon.push(E);
            } else if (sInside) {
                const I = intersection(S, E, clipEdgeStart, clipEdgeEnd);
                newPolygon.push(I);
            }
            S = E;
        }
    }
    return newPolygon;
}

function clipPolyline(polyline, clipPolygon) {
    const clippedLines = [];
    let currentLine = [];
    for (let i = 0; i < polyline.length - 1; i++) {
        const p1 = polyline[i];
        const p2 = polyline[i+1];
        const clippedSegment = cohenSutherlandClip(p1, p2, clipPolygon);
        if (clippedSegment) {
            if (currentLine.length > 0 && !currentLine[currentLine.length-1].equals(clippedSegment[0])) {
                clippedLines.push(currentLine);
                currentLine = [];
            }
            if(currentLine.length === 0) {
                 currentLine.push(clippedSegment[0]);
            }
            currentLine.push(clippedSegment[1]);
        } else {
            if (currentLine.length > 0) {
                clippedLines.push(currentLine);
                currentLine = [];
            }
        }
    }
    if (currentLine.length > 0) {
        clippedLines.push(currentLine);
    }
    return clippedLines;
}

function cohenSutherlandClip(p1, p2, boundsPolygon) {
    const min = boundsPolygon[3];
    const max = boundsPolygon[1];
    const INSIDE = 0; // 0000
    const LEFT = 1;   // 0001
    const RIGHT = 2;  // 0010
    const BOTTOM = 4; // 0100
    const TOP = 8;    // 1000

    const getCode = (p) => {
        let code = INSIDE;
        if (p.x < min.x) code |= LEFT;
        else if (p.x > max.x) code |= RIGHT;
        if (p.z < min.z) code |= BOTTOM;
        else if (p.z > max.z) code |= TOP;
        return code;
    };

    let code1 = getCode(p1);
    let code2 = getCode(p2);
    let accept = false;

    while (true) {
        if ((code1 === 0) && (code2 === 0)) {
            accept = true;
            break;
        } else if ((code1 & code2) !== 0) {
            break;
        } else {
            let codeOut = code1 !== 0 ? code1 : code2;
            let x, z;
            if (codeOut & TOP) {
                x = p1.x + (p2.x - p1.x) * (max.z - p1.z) / (p2.z - p1.z);
                z = max.z;
            } else if (codeOut & BOTTOM) {
                x = p1.x + (p2.x - p1.x) * (min.z - p1.z) / (p2.z - p1.z);
                z = min.z;
            } else if (codeOut & RIGHT) {
                z = p1.z + (p2.z - p1.z) * (max.x - p1.x) / (p2.x - p1.x);
                x = max.x;
            } else if (codeOut & LEFT) {
                z = p1.z + (p2.z - p1.z) * (min.x - p1.x) / (p2.x - p1.x);
                x = min.x;
            }

            if (codeOut === code1) {
                p1 = new THREE.Vector3(x, p1.y, z);
                code1 = getCode(p1);
            } else {
                p2 = new THREE.Vector3(x, p2.y, z);
                code2 = getCode(p2);
            }
        }
    }

    if (accept) {
        return [p1, p2];
    }
    return null;
}


function isInside(p, edgeStart, edgeEnd) {
    return (edgeEnd.x - edgeStart.x) * (p.z - edgeStart.z) > (edgeEnd.z - edgeStart.z) * (p.x - edgeStart.x);
}

function intersection(s, e, clipEdgeStart, clipEdgeEnd) {
    const dc = { x: clipEdgeStart.x - clipEdgeEnd.x, z: clipEdgeStart.z - clipEdgeEnd.z };
    const dp = { x: s.x - e.x, z: s.z - e.z };
    const n1 = clipEdgeStart.x * clipEdgeEnd.z - clipEdgeStart.z * clipEdgeEnd.x;
    const n2 = s.x * e.z - s.z * e.x;
    const n3 = 1.0 / (dc.x * dp.z - dc.z * dp.x);
    return new THREE.Vector3(
        (n1 * dp.x - n2 * dc.x) * n3,
        s.y,
        (n1 * dp.z - n2 * dc.z) * n3
    );
}

function fitCameraToBox(box, camera) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const cameraDistance = (maxDim / 2) / Math.tan(fov / 2);

    // A bit of a heuristic to get a nice initial angle
    camera.position.set(center.x, center.y + cameraDistance, center.z + cameraDistance);
    camera.lookAt(center);

    camera.far = cameraDistance * 3;
    camera.updateProjectionMatrix();

    if (controls) {
        controls.target.copy(center);
        controls.update();
    }
}


// 3D model container
const modelContainer = document.getElementById('model-container');
let scene, camera, renderer, controls;

function initThree() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeeeeee);

    // Camera
    camera = new THREE.PerspectiveCamera(75, modelContainer.clientWidth / modelContainer.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(modelContainer.clientWidth, modelContainer.clientHeight);
    modelContainer.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Handle window resize
    window.addEventListener('resize', () => {
        camera.aspect = modelContainer.clientWidth / modelContainer.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(modelContainer.clientWidth, modelContainer.clientHeight);
    });

    // Initial render
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

initThree();

const exportBtn = document.getElementById('export-btn');
exportBtn.addEventListener('click', () => {
    const exporter = new _3MFExporter();
    
    const modelSizeMM = document.getElementById('model-size').value;
    const sceneBbox = new THREE.Box3().setFromObject(scene);
    const sceneSize = sceneBbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(sceneSize.x, sceneSize.y, sceneSize.z);
    
    // Create a scaled version for export
    const exportScene = new THREE.Scene();
    const modelGroup = scene.getObjectByName("modelGroup");
    
    if (modelGroup) {
        const exportGroup = new THREE.Group();
        exportGroup.name = "exportGroup";
        
        // Calculate scale factor based on horizontal dimensions only
        const modelBounds = new THREE.Box3().setFromObject(modelGroup);
        const modelSize = modelBounds.getSize(new THREE.Vector3());
        const horizontalScale = parseFloat(modelSizeMM) / Math.max(modelSize.x, modelSize.z);
        
        modelGroup.children.forEach(child => {
            const clone = child.clone();
            
            // Scale horizontally
            clone.scale.x *= horizontalScale;
            clone.scale.z *= horizontalScale;
            clone.position.x *= horizontalScale;
            clone.position.z *= horizontalScale;
            
            // Use original heights for vertical scaling
            if (child.userData.originalHeight !== undefined) {
                const originalHeight = child.userData.originalHeight;
                clone.scale.y = originalHeight * horizontalScale / child.scale.y;
                clone.position.y = (child.position.y / child.scale.y) * clone.scale.y;
            } else {
                clone.scale.y *= horizontalScale;
                clone.position.y *= horizontalScale;
            }
            
            exportGroup.add(clone);
        });
        
        exportScene.add(exportGroup);
    }

    exporter.parse(exportScene, (result) => {
        const blob = new Blob([result], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
        const link = document.createElement('a');
        link.style.display = 'none';
        document.body.appendChild(link);
        link.href = URL.createObjectURL(blob);
        link.download = 'model.3mf';
        link.click();
        document.body.removeChild(link);
    });
}); 