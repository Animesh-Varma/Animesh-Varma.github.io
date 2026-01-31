// --- DOM References ---
const videoElement = document.querySelector('.input_video');
const canvasContainer = document.getElementById('canvas-container');
const loadingOverlay = document.getElementById('loadingOverlay');
const systemStatus = document.getElementById('systemStatus');
const statusDot = document.getElementById('statusDot');
const fpsCounter = document.getElementById('fpsCounter');
const loadDetail = document.getElementById('loadDetail');
const mainViewport = document.getElementById('main-viewport');

// --- Configuration ---
const CONFIG = {
    UPDATE_INTERVAL: 20, // Target ~50fps for AI
    HAND_COLOR: 0xFFFFFF, // White to match Lab Theme
    MAX_HANDS: 2
};

// --- Connection Map (23 connections) ---
const connections = [
    [0,1],[1,2],[2,3],[3,4],        // Thumb
    [0,5],[5,6],[6,7],[7,8],        // Index
    [0,9],[9,10],[10,11],[11,12],   // Middle
    [0,13],[13,14],[14,15],[15,16], // Ring
    [0,17],[17,18],[18,19],[19,20], // Pinky
    [5,9],[9,13],[13,17]            // Palm
];

// --- Globals ---
let scene, camera, renderer;
let handMeshes = [];
let hands;
let isProcessing = false;
let lastLoopTime = 0;

// --- Initialization ---
initThreeJS();
initMediaPipe();

// 1. Setup 3D Environment
function initThreeJS() {
    scene = new THREE.Scene();
    // Subtle fog to match the Lab surface container color
    scene.fog = new THREE.FogExp2(0x111111, 0.02);

    // Camera setup based on container size
    const width = mainViewport.clientWidth;
    const height = mainViewport.clientHeight;

    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 25;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvasContainer.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    // Grid Helper (Darker to blend with Lab theme)
    const gridHelper = new THREE.GridHelper(60, 60, 0x333333, 0x000000);
    gridHelper.position.y = -5;
    scene.add(gridHelper);

    // Generate Hand Meshes
    for (let h = 0; h < CONFIG.MAX_HANDS; h++) {
        let handGroup = new THREE.Group();
        let joints = [];
        let bones = [];

        // Geometries
        const jointGeo = new THREE.IcosahedronGeometry(0.4, 0);
        const jointMat = new THREE.MeshBasicMaterial({ color: CONFIG.HAND_COLOR });

        // Bones: White with transparency
        const boneGeo = new THREE.CylinderGeometry(0.15, 0.15, 1, 6);
        const boneMat = new THREE.MeshBasicMaterial({ color: CONFIG.HAND_COLOR, transparent: true, opacity: 0.3 });

        // 21 Joints
        for (let i = 0; i < 21; i++) {
            let mesh = new THREE.Mesh(jointGeo, jointMat);
            handGroup.add(mesh);
            joints.push(mesh);
        }

        // 25 Bones (Safe buffer for connections)
        for (let i = 0; i < 25; i++) {
            let bone = new THREE.Mesh(boneGeo, boneMat);
            handGroup.add(bone);
            bones.push(bone);
        }

        handGroup.visible = false;
        scene.add(handGroup);
        handMeshes.push({ joints, bones, group: handGroup });
    }

    // Handle Resize (Restricted to Main Viewport)
    window.addEventListener('resize', () => {
        const w = mainViewport.clientWidth;
        const h = mainViewport.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });

    renderLoop();
}

// 2. Setup AI
async function initMediaPipe() {
    loadDetail.innerText = "Initializing Neural Core...";

    hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: CONFIG.MAX_HANDS,
        modelComplexity: 0, // Lite Model for speed
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    hands.onResults(handleAIResults);

    try {
        loadDetail.innerText = "Requesting Optics...";
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: "user"
            }
        });

        videoElement.srcObject = stream;

        videoElement.onloadedmetadata = () => {
            videoElement.play();
            loadDetail.innerText = "Starting Uplink...";
            startDetectionLoop();
        };

    } catch (err) {
        console.error(err);
        systemStatus.innerText = "SIGNAL LOST";
        loadDetail.innerText = "Camera Access Denied";
        // Visual indicator of failure
        statusDot.style.backgroundColor = "#ff4444";
        statusDot.classList.remove('active');
    }
}

// 3. The Detection Loop (Throttled to ~20ms)
function startDetectionLoop() {
    const loop = async () => {
        const now = performance.now();

        if (videoElement.readyState >= 2 &&
            !isProcessing &&
            (now - lastLoopTime) >= CONFIG.UPDATE_INTERVAL) {

            lastLoopTime = now;
            isProcessing = true;

            try {
                await hands.send({ image: videoElement });
            } catch (e) {
                // Fail silently on dropped frames
            }

            isProcessing = false;
        }

        requestAnimationFrame(loop);
    };
    loop();
}

// 4. Handle Results (Update 3D Model)
function handleAIResults(results) {
    // Hide loader on first successful tracking
    if (!loadingOverlay.classList.contains('hidden')) {
        loadingOverlay.classList.add('hidden');
        systemStatus.innerText = "UPLINK ESTABLISHED";
        systemStatus.style.color = "var(--text-main)";
    }

    // Calculate Latency
    const now = performance.now();
    fpsCounter.innerText = Math.round(now - lastLoopTime);

    // Reset Visibility
    handMeshes.forEach(h => h.group.visible = false);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        statusDot.classList.add('active');

        results.multiHandLandmarks.forEach((landmarks, index) => {
            if (index >= CONFIG.MAX_HANDS) return;

            const hand = handMeshes[index];
            hand.group.visible = true;

            // Update Joints
            landmarks.forEach((lm, i) => {
                // Map Normalized (0-1) to World Space
                const x = (0.5 - lm.x) * 20;
                const y = (0.5 - lm.y) * 20;
                const z = -lm.z * 20;
                hand.joints[i].position.set(x, y, z);
            });

            // Update Bones
            let boneIdx = 0;
            connections.forEach(pair => {
                const a = hand.joints[pair[0]].position;
                const b = hand.joints[pair[1]].position;
                const bone = hand.bones[boneIdx];

                if(bone) {
                    bone.position.copy(a).add(b).multiplyScalar(0.5);
                    bone.lookAt(b);
                    bone.scale.set(1, 1, a.distanceTo(b));
                    bone.rotateX(Math.PI / 2);
                    bone.visible = true;
                }
                boneIdx++;
            });
        });
    } else {
        statusDot.classList.remove('active');
    }
}

// 5. Render Loop (Visuals Only)
function renderLoop() {
    requestAnimationFrame(renderLoop);
    // Idle Animation
    if (!statusDot.classList.contains('active')) {
        scene.rotation.y = Math.sin(Date.now() * 0.0005) * 0.05;
    }
    renderer.render(scene, camera);
}