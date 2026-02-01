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
    // AI Settings
    UPDATE_INTERVAL: 20,
    complexity: 1,
    SMOOTHING_FACTOR: 0.6,

    // Physics Thresholds
    FIST_THRESHOLD: 6.0,      // Distance avg (Wrist to fingertips) to trigger "Fist"
    DISPERSE_DISTANCE: 3.5,   // Distance between hands to trigger "Explosion"

    // Swarm Settings
    PARTICLE_COUNT: 2500,
    MAX_SPEED: 0.9,           // Base speed

    // Visuals
    PARTICLE_COLOR: 0x00ff9d,
    HAND_COLOR: 0xFFFFFF,
    MAX_HANDS: 2,
    WORLD_SCALE: 20
};

// --- Connection Map ---
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
let handState = [];
let hands;
let particles, particleGeo, particleData;
let isProcessing = false;
let lastLoopTime = 0;

// --- Initialization ---
initThreeJS();
initMediaPipe();

// 1. Setup 3D Environment
function initThreeJS() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.02);

    const width = mainViewport.clientWidth;
    const height = mainViewport.clientHeight;

    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 25;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvasContainer.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    createSwarmParticles();

    // Create Hands
    for (let h = 0; h < CONFIG.MAX_HANDS; h++) {
        // Visuals
        let handGroup = new THREE.Group();
        let joints = [];
        let bones = [];

        const jointGeo = new THREE.IcosahedronGeometry(0.3, 0);
        const jointMat = new THREE.MeshBasicMaterial({ color: CONFIG.HAND_COLOR });
        const boneGeo = new THREE.CylinderGeometry(0.1, 0.1, 1, 6);
        const boneMat = new THREE.MeshBasicMaterial({ color: CONFIG.HAND_COLOR, transparent: true, opacity: 0.3 });

        for (let i = 0; i < 21; i++) {
            let mesh = new THREE.Mesh(jointGeo, jointMat);
            handGroup.add(mesh);
            joints.push(mesh);
        }
        for (let i = 0; i < connections.length; i++) {
            let bone = new THREE.Mesh(boneGeo, boneMat);
            handGroup.add(bone);
            bones.push(bone);
        }

        handGroup.visible = false;
        scene.add(handGroup);
        handMeshes.push({ joints, bones, group: handGroup });

        // Logic State
        handState.push({
            active: false,
            center: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            prevCenter: new THREE.Vector3(),
            targets: Array(21).fill().map(() => new THREE.Vector3()),
            isFist: false // New State
        });
    }

    window.addEventListener('resize', () => {
        const w = mainViewport.clientWidth;
        const h = mainViewport.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });

    renderLoop();
}

function createSwarmParticles() {
    particleGeo = new THREE.BufferGeometry();
    const positions = [];
    particleData = [];

    for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
        const x = (Math.random() - 0.5) * 80;
        const y = (Math.random() - 0.5) * 60;
        const z = (Math.random() - 0.5) * 40;
        positions.push(x, y, z);

        particleData.push({
            velocity: new THREE.Vector3(
                (Math.random() - 0.5) * 0.5,
                (Math.random() - 0.5) * 0.5,
                (Math.random() - 0.5) * 0.5
            ),
            offset: Math.random() * 100,
            speedVar: 0.5 + Math.random() * 0.8
        });
    }

    particleGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const pMat = new THREE.PointsMaterial({
        color: CONFIG.PARTICLE_COLOR,
        size: 0.18,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    particles = new THREE.Points(particleGeo, pMat);
    scene.add(particles);
}

// 2. Setup AI
async function initMediaPipe() {
    loadDetail.innerText = "Loading Neural Physics...";

    hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: CONFIG.MAX_HANDS,
        modelComplexity: CONFIG.complexity,
        minDetectionConfidence: 0.75,
        minTrackingConfidence: 0.75
    });

    hands.onResults(handleAIResults);

    try {
        loadDetail.innerText = "Requesting Optics...";
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
        });
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
            videoElement.play();
            loadDetail.innerText = "Starting Uplink...";
            startDetectionLoop();
        };
    } catch (err) {
        systemStatus.innerText = "SIGNAL LOST";
        loadDetail.innerText = "Camera Access Denied";
        statusDot.style.backgroundColor = "red";
    }
}

// 3. Detection Loop
function startDetectionLoop() {
    const loop = async () => {
        const now = performance.now();
        if (videoElement.readyState >= 2 && !isProcessing && (now - lastLoopTime) >= CONFIG.UPDATE_INTERVAL) {
            lastLoopTime = now;
            isProcessing = true;
            try { await hands.send({ image: videoElement }); } catch (e) {}
            isProcessing = false;
        }
        requestAnimationFrame(loop);
    };
    loop();
}

// 4. Handle Results
function handleAIResults(results) {
    if (!loadingOverlay.classList.contains('hidden')) {
        loadingOverlay.classList.add('hidden');
        systemStatus.innerText = "UPLINK ESTABLISHED";
        systemStatus.style.color = "var(--text-main)";
    }

    fpsCounter.innerText = Math.round(performance.now() - lastLoopTime);

    handState.forEach(h => h.active = false);

    if (results.multiHandLandmarks) {
        statusDot.classList.add('active');
        results.multiHandLandmarks.forEach((landmarks, index) => {
            if (index >= CONFIG.MAX_HANDS) return;

            const state = handState[index];
            state.active = true;

            landmarks.forEach((lm, i) => {
                const x = (0.5 - lm.x) * CONFIG.WORLD_SCALE;
                const y = (0.5 - lm.y) * CONFIG.WORLD_SCALE;
                const z = -lm.z * CONFIG.WORLD_SCALE;
                state.targets[i].set(x, y, z);
            });
        });
    } else {
        statusDot.classList.remove('active');
    }
}

// 5. Render Loop (Visuals + Logic)
function renderLoop() {
    requestAnimationFrame(renderLoop);
    const now = Date.now();

    // A. Update Hands
    for (let i = 0; i < CONFIG.MAX_HANDS; i++) {
        const visual = handMeshes[i];
        const state = handState[i];

        if (state.active) {
            visual.group.visible = true;

            // Update Joints
            for (let j = 0; j < 21; j++) {
                visual.joints[j].position.lerp(state.targets[j], CONFIG.SMOOTHING_FACTOR);
            }

            // Update Bones
            connections.forEach((pair, boneIdx) => {
                const a = visual.joints[pair[0]].position;
                const b = visual.joints[pair[1]].position;
                const bone = visual.bones[boneIdx];
                if(bone) {
                    bone.position.copy(a).add(b).multiplyScalar(0.5);
                    bone.lookAt(b);
                    bone.scale.set(1, 1, a.distanceTo(b));
                    bone.rotateX(Math.PI / 2);
                }
            });

            // Physics Stats
            // Center = Palm
            state.center.copy(visual.joints[0].position).add(visual.joints[9].position).multiplyScalar(0.5);
            state.velocity.subVectors(state.center, state.prevCenter);
            state.prevCenter.copy(state.center);

            // --- FIST DETECTION ---
            // Calculate avg distance from Wrist(0) to Tips(8,12,16,20)
            const wrist = visual.joints[0].position;
            const tips = [8, 12, 16, 20];
            let totalDist = 0;
            tips.forEach(idx => {
                totalDist += wrist.distanceTo(visual.joints[idx].position);
            });
            const avgDist = totalDist / 4;

            // Hysteresis or simple threshold
            state.isFist = avgDist < CONFIG.FIST_THRESHOLD;

        } else {
            visual.group.visible = false;
        }
    }

    // B. Update Boids
    updateBoids(now * 0.001);

    // C. Idle Cam
    if (!statusDot.classList.contains('active')) {
        scene.rotation.y = Math.sin(now * 0.0005) * 0.05;
    }

    renderer.render(scene, camera);
}

function updateBoids(time) {
    if (!particles) return;

    const positions = particleGeo.attributes.position.array;
    const count = CONFIG.PARTICLE_COUNT;
    const activeHands = handState.filter(h => h.active);

    const vPos = new THREE.Vector3();
    const vTarget = new THREE.Vector3();
    const vSteer = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        let ix = i * 3;
        vPos.set(positions[ix], positions[ix+1], positions[ix+2]);
        const pData = particleData[i];

        let mode = "IDLE"; // IDLE, SINGLE, DUAL, EXPLODE
        let targetRadius = 5.0; // How spread out the swarm is

        // 1. Determine Mode & Target
        if (activeHands.length === 0) {
            // IDLE
            vTarget.set(
                Math.sin(time * 0.5 + pData.offset) * 15,
                Math.cos(time * 0.3 + pData.offset) * 10,
                Math.sin(time * 0.2) * 5
            );
        } else if (activeHands.length === 1) {
            // SINGLE HAND
            const h = activeHands[0];
            vTarget.copy(h.center);

            if (h.isFist) {
                // TIGHT: Condensed Energy
                targetRadius = 1.5;
            } else {
                // LOOSE: Bird Swarm
                targetRadius = 8.0;
            }
        } else {
            // DUAL HANDS (Sphere Between)
            const h1 = activeHands[0];
            const h2 = activeHands[1];
            const dist = h1.center.distanceTo(h2.center);
            const midPoint = new THREE.Vector3().addVectors(h1.center, h2.center).multiplyScalar(0.5);

            if (dist < CONFIG.DISPERSE_DISTANCE) {
                // TOO CLOSE -> EXPLODE
                mode = "EXPLODE";
                vTarget.copy(midPoint); // Origin of explosion
            } else {
                // SPHERE FORMATION
                // The sphere radius depends on hand distance
                // Far hands = Big Sphere. Close hands = Tight Sphere.
                targetRadius = dist * 0.6;
                vTarget.copy(midPoint);
            }
        }

        // 2. Calculate Forces
        const distToTarget = vPos.distanceTo(vTarget);

        if (mode === "EXPLODE") {
            // --- EXPLOSION LOGIC ---
            // Repel strongly from center
            vSteer.subVectors(vPos, vTarget).normalize().multiplyScalar(CONFIG.MAX_SPEED * 3.0);

        } else {
            // --- SWARM LOGIC ---

            // Vector pointing to target center
            const vecToCenter = new THREE.Vector3().subVectors(vTarget, vPos);

            // "Orbit" Force: Push perpendicular to center vector to create rotation
            // Cross product with UP vector usually works for simple orbit
            const orbitDir = new THREE.Vector3(-vecToCenter.z, vecToCenter.y, vecToCenter.x).normalize();

            // Distance Check
            if (distToTarget > targetRadius) {
                // Too far? Pull In (Cohesion)
                vSteer.copy(vecToCenter).normalize().multiplyScalar(CONFIG.MAX_SPEED);
            } else {
                // Inside radius?
                // 1. Maintain orbit (Swirl)
                vSteer.copy(orbitDir).multiplyScalar(CONFIG.MAX_SPEED * 0.8);

                // 2. Slight repulsion if TOO close to center (Hollow shell effect)
                if (distToTarget < targetRadius * 0.3) {
                     const pushOut = vecToCenter.clone().negate().normalize().multiplyScalar(CONFIG.MAX_SPEED * 0.5);
                     vSteer.add(pushOut);
                }
            }
        }

        // 3. Noise / Jitter (Bird-like randomness)
        vSteer.x += (Math.random() - 0.5) * 0.15;
        vSteer.y += (Math.random() - 0.5) * 0.15;
        vSteer.z += (Math.random() - 0.5) * 0.15;

        // 4. Physics Integration
        // Add Steering to Velocity
        pData.velocity.add(vSteer.multiplyScalar(0.05)); // Inertia factor

        // Clamp Speed
        const speedLimit = mode === "EXPLODE" ? CONFIG.MAX_SPEED * 3 : CONFIG.MAX_SPEED * pData.speedVar;
        pData.velocity.clampLength(0, speedLimit);

        // Move
        vPos.add(pData.velocity);

        // 5. Hand Drag (If single hand)
        if (activeHands.length === 1) {
            vPos.add(activeHands[0].velocity.clone().multiplyScalar(0.2));
        }

        positions[ix] = vPos.x;
        positions[ix+1] = vPos.y;
        positions[ix+2] = vPos.z;
    }

    particleGeo.attributes.position.needsUpdate = true;
}