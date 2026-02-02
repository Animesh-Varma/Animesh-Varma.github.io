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
    SMOOTHING_FACTOR: 0.5,

    // Hand Metrics (World Scale 20)
    OPEN_HAND_SIZE: 9.0,
    CLOSED_HAND_SIZE: 3.5,

    // Physics - Interaction
    BASE_SPEED: 0.6,         // Speed when hand is Open
    MAX_SPEED: 1.8,          // Speed when hand is Fist

    // Gravity / Pull
    MIN_COHESION: 0.01,      // Gentle pull (Open)
    MAX_COHESION: 0.17,      // Strong Black Hole pull (Fist)

    // Volume
    MAX_RADIUS: 13.0,        // Swarm size (Open)
    MIN_RADIUS: 0.5,         // Swarm size (Fist)

    // Explosion
    EXPLOSION_FORCE: 2.0,
    EXPLOSION_COOLDOWN: 500,
    DISPERSE_DISTANCE: 2.0,

    // Idle / Decay
    IDLE_RETURN_FORCE: 0.005,
    IDLE_FRICTION: 0.98,

    // Visuals
    PARTICLE_COUNT: 2500,
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

// Reusable Vectors (Memory Optimization)
const _vPos = new THREE.Vector3();
const _vVel = new THREE.Vector3();
const _vTarget = new THREE.Vector3();
const _vSteer = new THREE.Vector3();
const _vTemp = new THREE.Vector3(); // Fixed: Added missing definition

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

        handState.push({
            active: false,
            center: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            prevCenter: new THREE.Vector3(),
            targets: Array(21).fill().map(() => new THREE.Vector3()),
            clenchFactor: 0.0,
            isExploding: false,
            lastExplosionTime: 0
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
        const x = (Math.random() - 0.5) * 100;
        const y = (Math.random() - 0.5) * 80;
        const z = (Math.random() - 0.5) * 60;
        positions.push(x, y, z);

        particleData.push({
            velocity: new THREE.Vector3(
                Math.random()-0.5, Math.random()-0.5, Math.random()-0.5
            ).normalize(),
            offset: Math.random() * 100,
            speedVar: 0.8 + Math.random() * 0.4
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
    loadDetail.innerText = "Loading Swarm Logic...";

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

// 5. Render Loop
function renderLoop() {
    requestAnimationFrame(renderLoop);
    const now = Date.now();

    // A. Update Hands
    for (let i = 0; i < CONFIG.MAX_HANDS; i++) {
        const visual = handMeshes[i];
        const state = handState[i];

        if (state.active) {
            visual.group.visible = true;

            // Joints Lerp
            for (let j = 0; j < 21; j++) {
                visual.joints[j].position.lerp(state.targets[j], CONFIG.SMOOTHING_FACTOR);
            }
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

            // State Updates
            state.center.copy(visual.joints[0].position).add(visual.joints[9].position).multiplyScalar(0.5);
            state.velocity.subVectors(state.center, state.prevCenter);
            state.prevCenter.copy(state.center);

            // --- Clench Calculation ---
            const wrist = visual.joints[0].position;
            const tips = [4, 8, 12, 16, 20];
            let totalDist = 0;
            tips.forEach(idx => { totalDist += wrist.distanceTo(visual.joints[idx].position); });
            const avgDist = totalDist / 5;
            let rawClench = (CONFIG.OPEN_HAND_SIZE - avgDist) / (CONFIG.OPEN_HAND_SIZE - CONFIG.CLOSED_HAND_SIZE);
            state.clenchFactor = Math.max(0, Math.min(1, rawClench));

            // --- Gesture Detection (Shooter / Three) ---
            const dRing = wrist.distanceTo(visual.joints[16].position);
            const dPinky = wrist.distanceTo(visual.joints[20].position);
            const dIndex = wrist.distanceTo(visual.joints[8].position);

            // Heuristic: Ring/Pinky Closed (<4.5) AND Index Open (>5.5)
            const isShooterPose = (dRing < 4.5 && dPinky < 4.5 && dIndex > 5.5);

            if (isShooterPose && !state.isExploding && (now - state.lastExplosionTime > CONFIG.EXPLOSION_COOLDOWN)) {
                state.isExploding = true;
                state.lastExplosionTime = now;
                setTimeout(() => { state.isExploding = false; }, 200);
            }

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

    // Mode determination
    let mode = "IDLE";
    let attractorVec = _vTemp.set(0,0,0);

    // Dynamic Physics Variables
    let currentMaxSpeed = CONFIG.BASE_SPEED;
    let currentCohesion = CONFIG.MIN_COHESION;
    let targetRadius = CONFIG.MAX_RADIUS;

    if (activeHands.length === 0) {
        mode = "IDLE";
    } else if (activeHands.length === 1) {
        mode = "SINGLE";
        const h = activeHands[0];

        if (h.isExploding) {
            mode = "EXPLODE";
            attractorVec.copy(h.center);
        } else {
            attractorVec.copy(h.center);

            // --- ANALOG ACCELERATION ---
            currentMaxSpeed = CONFIG.BASE_SPEED + (h.clenchFactor * (CONFIG.MAX_SPEED - CONFIG.BASE_SPEED));
            targetRadius = CONFIG.MAX_RADIUS - (h.clenchFactor * (CONFIG.MAX_RADIUS - CONFIG.MIN_RADIUS));
            currentCohesion = CONFIG.MIN_COHESION + (h.clenchFactor * (CONFIG.MAX_COHESION - CONFIG.MIN_COHESION));
        }
    } else {
        const h1 = activeHands[0];
        const h2 = activeHands[1];
        const dist = h1.center.distanceTo(h2.center);
        const mid = _vTemp.copy(h1.center).add(h2.center).multiplyScalar(0.5);

        if (dist < CONFIG.DISPERSE_DISTANCE) {
            mode = "EXPLODE";
            attractorVec.copy(mid);
        } else {
            mode = "DUAL";
            attractorVec.copy(mid);
            const avgClench = (h1.clenchFactor + h2.clenchFactor) / 2;
            currentMaxSpeed = CONFIG.BASE_SPEED + (avgClench * (CONFIG.MAX_SPEED - CONFIG.BASE_SPEED));
            targetRadius = Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, dist * 0.6));
        }
    }

    // Optimized Loop
    for (let i = 0; i < count; i++) {
        let ix = i * 3;
        const pData = particleData[i];

        // Read Position
        _vPos.set(positions[ix], positions[ix+1], positions[ix+2]);
        _vVel.copy(pData.velocity);

        if (mode === "EXPLODE") {
            _vSteer.subVectors(_vPos, attractorVec).normalize().multiplyScalar(CONFIG.EXPLOSION_FORCE);
            _vVel.add(_vSteer);
        }
        else if (mode === "IDLE") {
            // Decay Logic
            _vTarget.set(
                Math.sin(time * 0.5 + pData.offset) * 20,
                Math.cos(time * 0.3 + pData.offset) * 15,
                Math.sin(time * 0.2) * 10
            );

            _vSteer.subVectors(_vTarget, _vPos).multiplyScalar(CONFIG.IDLE_RETURN_FORCE);
            _vVel.add(_vSteer);

            _vVel.x += (Math.random()-0.5) * 0.01;
            _vVel.y += (Math.random()-0.5) * 0.01;
            _vVel.z += (Math.random()-0.5) * 0.01;

            _vVel.multiplyScalar(CONFIG.IDLE_FRICTION);
        }
        else {
            // INTERACTION
            const distToCenter = _vPos.distanceTo(attractorVec);
            _vTarget.subVectors(attractorVec, _vPos);

            // Variable Cohesion
            if (distToCenter > targetRadius) {
                _vSteer.copy(_vTarget).normalize().multiplyScalar(currentCohesion);
            } else {
                _vSteer.copy(_vTarget).negate().normalize().multiplyScalar(0.01);
            }
            _vVel.add(_vSteer);

            // Chaos reduces as hand closes
            const chaosFactor = 0.08 * (1.0 - (currentCohesion * 5));
            _vSteer.set(
                Math.sin(time * 2.0 + _vPos.y * 0.1 + pData.offset),
                Math.cos(time * 1.5 + _vPos.z * 0.1 + pData.offset),
                Math.sin(time * 2.5 + _vPos.x * 0.1)
            ).multiplyScalar(Math.max(0, chaosFactor));
            _vVel.add(_vSteer);

            // Hand Drag
            if (activeHands.length === 1) {
                _vVel.add(activeHands[0].velocity.clone().multiplyScalar(0.1));
            }

            _vVel.multiplyScalar(0.96);
            _vVel.clampLength(0, currentMaxSpeed * pData.speedVar);
        }

        // Move
        _vPos.add(_vVel);

        // Write Back
        positions[ix] = _vPos.x;
        positions[ix+1] = _vPos.y;
        positions[ix+2] = _vPos.z;
        pData.velocity.copy(_vVel);
    }

    particleGeo.attributes.position.needsUpdate = true;
}