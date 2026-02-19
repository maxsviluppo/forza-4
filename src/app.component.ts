import { Component, ElementRef, ViewChild, AfterViewInit, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const ROWS = 6;
const COLS = 7;
const EMPTY = 0;
const PLAYER_HUMAN = 1;
const PLAYER_AI = 2;
const COLOR_P1 = 0xff0044;
const COLOR_P2 = 0xffcc00;
const COLOR_GRID = 0x0088ff;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: []
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvasContainer') canvasRef!: ElementRef<HTMLDivElement>;

  gameMode = signal<'PvP' | 'PvAI'>('PvAI');
  currentPlayer = signal<number>(PLAYER_HUMAN);
  winner = signal<number | null>(null);
  isDraw = signal<boolean>(false);
  isThinking = signal<boolean>(false);
  
  stats = signal({
    pvpRed: 0,
    pvpYellow: 0,
    pvaiHuman: 0,
    pvaiAi: 0,
    draws: 0
  });

  statusText = computed(() => {
    if (this.winner() !== null) {
      return this.winner() === PLAYER_HUMAN ? 'Vince il Rosso!' : (this.gameMode() === 'PvAI' ? 'Vince l\'AI!' : 'Vince il Giallo!');
    }
    if (this.isDraw()) return 'Pareggio!';
    if (this.isThinking()) return 'AI sta pensando...';
    return this.currentPlayer() === PLAYER_HUMAN ? 'TURNO: ROSSO' : 'TURNO: GIALLO';
  });

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private pieces: THREE.Mesh[] = [];
  private gridMesh!: THREE.Mesh;
  private hoverMesh!: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private board: number[][] = [];
  private animationId: number = 0;
  private isAnimatingDrop = false;
  private audioCtx: AudioContext | null = null;
  private particles: { mesh: THREE.Mesh, velocity: THREE.Vector3, life: number }[] = [];
  private cameraShake = 0;

  constructor() {
    this.loadStats();
    this.resetBoardLogic();
  }
  
  private createParticles(x: number, y: number, color: number) {
    const particleCount = 20;
    const geometry = new THREE.SphereGeometry(0.08, 8, 8);
    const material = new THREE.MeshBasicMaterial({ color: color });

    for (let i = 0; i < particleCount; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, 0.25);
      
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.2
      );
      
      this.scene.add(mesh);
      this.particles.push({ mesh, velocity, life: 1.0 });
    }
  }

  private updateParticles() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= 0.02;
      p.mesh.position.add(p.velocity);
      p.mesh.scale.setScalar(p.life);
      
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
  }

  private initAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  private playDropSound() {
    if (!this.audioCtx) return;
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, this.audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, this.audioCtx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.3, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.2);

    osc.start();
    osc.stop(this.audioCtx.currentTime + 0.2);
  }

  private playWinSound() {
    if (!this.audioCtx) return;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C Major
    notes.forEach((freq, i) => {
      const osc = this.audioCtx!.createOscillator();
      const gain = this.audioCtx!.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx!.destination);

      osc.type = 'triangle';
      osc.frequency.value = freq;
      
      const startTime = this.audioCtx!.currentTime + (i * 0.1);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.2, startTime + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + 1.5);

      osc.start(startTime);
      osc.stop(startTime + 1.5);
    });
  }

  private loadStats() {
    const saved = localStorage.getItem('forza4_stats');
    if (saved) {
      try {
        this.stats.set(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse stats', e);
      }
    }
  }

  private saveStats() {
    localStorage.setItem('forza4_stats', JSON.stringify(this.stats()));
  }

  resetStats() {
    this.stats.set({
      pvpRed: 0,
      pvpYellow: 0,
      pvaiHuman: 0,
      pvaiAi: 0,
      draws: 0
    });
    this.saveStats();
  }

  ngAfterViewInit() {
    // Timeout minimo per assicurarsi che il layout DOM sia stabilizzato
    setTimeout(() => {
      this.initThree();
      this.createBoardVisuals();
      this.onWindowResize(); // Forza ridimensionamento iniziale
      this.animate();
    }, 50);
    
    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.canvasRef.nativeElement.addEventListener('click', this.onMouseClick.bind(this));
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.animationId);
    window.removeEventListener('resize', this.onWindowResize.bind(this));
    if (this.renderer) this.renderer.dispose();
  }

  private initThree() {
    const container = this.canvasRef.nativeElement;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    // Camera centrata sull'asse Y per inquadrare perfettamente la scacchiera
    this.camera.position.set(0, 0, 18); 
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    
    // Stile CSS per forzare il riempimento
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    
    container.appendChild(this.renderer.domElement);

    const renderScene = new RenderPass(this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.2;
    bloomPass.strength = 1.0; 
    bloomPass.radius = 0.5;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderScene);
    this.composer.addPass(bloomPass);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(5, 10, 7);
    this.scene.add(dirLight);

    const pointLight = new THREE.PointLight(0xffffff, 1.0, 50);
    pointLight.position.set(0, 0, 10); 
    this.scene.add(pointLight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 1.5;
    this.controls.target.set(0, 0, 0);
  }

  private createBoardVisuals() {
    const shape = new THREE.Shape();
    const boardWidth = COLS * 1.2;
    const boardHeight = ROWS * 1.2;
    const radius = 0.45;

    shape.moveTo(-boardWidth / 2, -boardHeight / 2);
    shape.lineTo(boardWidth / 2, -boardHeight / 2);
    shape.lineTo(boardWidth / 2, boardHeight / 2);
    shape.lineTo(-boardWidth / 2, boardHeight / 2);
    shape.lineTo(-boardWidth / 2, -boardHeight / 2);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hole = new THREE.Path();
        const x = (c - (COLS - 1) / 2) * 1.2;
        const y = (r - (ROWS - 1) / 2) * 1.2;
        hole.absarc(x, y, radius, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }

    const extrudeSettings = { depth: 0.5, bevelEnabled: true, bevelSegments: 2, steps: 2, bevelSize: 0.1, bevelThickness: 0.1 };
    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    const material = new THREE.MeshPhysicalMaterial({
      color: COLOR_GRID,
      metalness: 0.4,
      roughness: 0.2,
      transmission: 0.3,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      clearcoat: 1.0
    });

    this.gridMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.gridMesh);

    const planeGeo = new THREE.PlaneGeometry(boardWidth, boardHeight);
    const planeMat = new THREE.MeshBasicMaterial({ visible: false });
    this.hoverMesh = new THREE.Mesh(planeGeo, planeMat);
    this.scene.add(this.hoverMesh);
  }

  private resetBoardLogic() {
    this.board = Array(ROWS).fill(null).map(() => Array(COLS).fill(EMPTY));
    this.currentPlayer.set(PLAYER_HUMAN);
    this.winner.set(null);
    this.isDraw.set(false);
    this.isAnimatingDrop = false;
    this.cameraShake = 0;
    if (this.camera) {
       this.camera.position.set(0, 0, 18);
       this.camera.lookAt(0, 0, 0);
    }
    if (this.pieces && this.scene) this.pieces.forEach(p => this.scene.remove(p));
    this.pieces = [];
    if (this.particles && this.scene) {
       this.particles.forEach(p => this.scene.remove(p.mesh));
       this.particles = [];
    }
    if (this.gridMesh) {
      const mat = this.gridMesh.material as THREE.MeshPhysicalMaterial;
      mat.color.setHex(COLOR_GRID);
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  }

  resetGame() { this.resetBoardLogic(); }
  setMode(mode: 'PvP' | 'PvAI') { this.gameMode.set(mode); this.resetGame(); }

  private animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    
    // Camera Shake
    if (this.cameraShake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.cameraShake;
      this.camera.position.y += (Math.random() - 0.5) * this.cameraShake;
      this.cameraShake *= 0.9;
      if (this.cameraShake < 0.01) {
         this.cameraShake = 0;
         this.camera.position.set(0, 0, 18); // Reset position
         this.camera.lookAt(0, 0, 0);
      }
    }

    this.updateParticles();

    this.pieces.forEach(piece => {
      if (piece.userData['targetY'] !== undefined) {
        if (piece.position.y > piece.userData['targetY']) {
          piece.userData['velocity'] = (piece.userData['velocity'] || 0) + 0.02;
          piece.position.y -= piece.userData['velocity'];
          if (piece.position.y <= piece.userData['targetY']) {
             piece.position.y = piece.userData['targetY'];
             // Impact effect
             if (Math.abs(piece.userData['velocity']) > 0.1) {
                this.createParticles(piece.position.x, piece.position.y, (piece.material as THREE.MeshStandardMaterial).color.getHex());
             }

             if (piece.userData['velocity'] > 0.1) piece.userData['velocity'] = -piece.userData['velocity'] * 0.3;
             else { delete piece.userData['targetY']; delete piece.userData['velocity']; }
          }
        }
      }
      if (piece.userData['isWinningPiece']) {
         const scale = 1 + Math.sin(Date.now() * 0.015) * 0.1;
         piece.scale.set(scale, scale, scale);
         // Emit particles from winning pieces
         if (Math.random() > 0.9) {
            this.createParticles(piece.position.x, piece.position.y, (piece.material as THREE.MeshStandardMaterial).color.getHex());
         }
      }
    });
    this.composer.render();
  }

  private onWindowResize() {
    if (!this.renderer || !this.camera) return;
    const container = this.canvasRef.nativeElement;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private onMouseClick(event: MouseEvent) {
    this.initAudio();
    if (this.winner() !== null || this.isAnimatingDrop || this.isThinking()) return;
    if (this.gameMode() === 'PvAI' && this.currentPlayer() === PLAYER_AI) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.hoverMesh);
    if (intersects.length > 0) {
      const point = intersects[0].point;
      const boardLeft = - (COLS * 1.2) / 2;
      let col = Math.floor((point.x - boardLeft) / 1.2);
      if (col >= 0 && col < COLS) this.attemptMove(col);
    }
  }

  private attemptMove(col: number) {
    const row = this.getLowestEmptyRow(col);
    if (row === -1) return;
    this.makeMove(row, col, this.currentPlayer());
    this.playDropSound();
    if (this.checkWin(this.currentPlayer())) {
      this.winner.set(this.currentPlayer());
      this.updateStats(this.currentPlayer());
      const winLine = this.findWinningLine(this.currentPlayer());
      if (winLine) {
        this.triggerWinAnimation(winLine, this.currentPlayer());
        this.playWinSound();
      }
    } else if (this.checkDraw()) {
      this.isDraw.set(true);
      this.updateStats(null);
    }
    else {
      this.currentPlayer.set(this.currentPlayer() === PLAYER_HUMAN ? PLAYER_AI : PLAYER_HUMAN);
      if (this.gameMode() === 'PvAI' && this.currentPlayer() === PLAYER_AI && this.winner() === null) {
        this.isThinking.set(true);
        setTimeout(() => this.performAIMove(), 600);
      }
    }
  }

  private updateStats(winner: number | null) {
    const currentStats = this.stats();
    const mode = this.gameMode();

    if (winner === null) {
      currentStats.draws++;
    } else if (mode === 'PvP') {
      if (winner === PLAYER_HUMAN) currentStats.pvpRed++;
      else currentStats.pvpYellow++;
    } else {
      if (winner === PLAYER_HUMAN) currentStats.pvaiHuman++;
      else currentStats.pvaiAi++;
    }
    
    this.stats.set({...currentStats});
    this.saveStats();
  }

  private makeMove(row: number, col: number, player: number) {
    this.board[row][col] = player;
    const geometry = new THREE.SphereGeometry(0.4, 32, 32);
    const color = player === PLAYER_HUMAN ? COLOR_P1 : COLOR_P2;
    const material = new THREE.MeshStandardMaterial({
      color: color, emissive: color, emissiveIntensity: 0.8, roughness: 0.1, metalness: 0.5
    });
    const piece = new THREE.Mesh(geometry, material);
    const x = (col - (COLS - 1) / 2) * 1.2;
    const targetY = (row - (ROWS - 1) / 2) * 1.2;
    piece.position.set(x, 6, 0.25);
    piece.userData = { targetY: targetY, velocity: 0, r: row, c: col };
    this.scene.add(piece);
    this.pieces.push(piece);
  }

  private triggerWinAnimation(coords: {r: number, c: number}[], winner: number) {
    this.cameraShake = 0.5; // Start shake
    const winColor = winner === PLAYER_HUMAN ? COLOR_P1 : COLOR_P2;
    if (this.gridMesh) {
      const mat = this.gridMesh.material as THREE.MeshPhysicalMaterial;
      mat.color.setHex(winColor);
      mat.emissive.setHex(winColor);
      mat.emissiveIntensity = 0.5;
    }
    this.pieces.forEach(p => {
      const isWinner = coords.some(c => c.r === p.userData['r'] && c.c === p.userData['c']);
      const mat = p.material as THREE.MeshStandardMaterial;
      if (isWinner) {
        p.userData['isWinningPiece'] = true;
        mat.emissiveIntensity = 3.0;
      } else {
        mat.opacity = 0.2;
        mat.transparent = true;
        mat.emissiveIntensity = 0.1;
      }
    });
  }

  private findWinningLine(player: number): {r: number, c: number}[] | null {
    const board = this.board;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (board[r][c] === player && board[r][c+1] === player && board[r][c+2] === player && board[r][c+3] === player) return [{r, c}, {r, c: c+1}, {r, c: c+2}, {r, c: c+3}];
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c] === player && board[r+1][c] === player && board[r+2][c] === player && board[r+3][c] === player) return [{r, c}, {r: r+1, c}, {r: r+2, c}, {r: r+3, c}];
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (board[r][c] === player && board[r+1][c+1] === player && board[r+2][c+2] === player && board[r+3][c+3] === player) return [{r, c}, {r: r+1, c: c+1}, {r: r+2, c: c+2}, {r: r+3, c: c+3}];
      }
    }
    for (let r = 3; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (board[r][c] === player && board[r-1][c+1] === player && board[r-2][c+2] === player && board[r-3][c+3] === player) return [{r, c}, {r: r-1, c: c+1}, {r: r-2, c: c+2}, {r: r-3, c: c+3}];
      }
    }
    return null;
  }

  private getLowestEmptyRow(col: number): number {
    for (let r = 0; r < ROWS; r++) if (this.board[r][col] === EMPTY) return r;
    return -1;
  }

  private checkWin(player: number, boardState: number[][] = this.board): boolean {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (boardState[r][c] === player && boardState[r][c+1] === player && boardState[r][c+2] === player && boardState[r][c+3] === player) return true;
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS; c++) {
        if (boardState[r][c] === player && boardState[r+1][c] === player && boardState[r+2][c] === player && boardState[r+3][c] === player) return true;
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (boardState[r][c] === player && boardState[r+1][c+1] === player && boardState[r+2][c+2] === player && boardState[r+3][c+3] === player) return true;
      }
    }
    for (let r = 3; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        if (boardState[r][c] === player && boardState[r-1][c+1] === player && boardState[r-2][c+2] === player && boardState[r-3][c+3] === player) return true;
      }
    }
    return false;
  }

  private checkDraw(): boolean { return this.board.every(row => row.every(cell => cell !== EMPTY)); }

  private performAIMove() {
    this.isThinking.set(false);
    const boardCopy = this.board.map(row => [...row]);
    const [bestScore, bestCol] = this.minimax(boardCopy, 4, -Infinity, Infinity, true);
    if (bestCol !== -1) this.attemptMove(bestCol);
    else {
      const validCols = [];
      for(let c=0; c<COLS; c++) if(this.board[ROWS-1][c] === EMPTY) validCols.push(c);
      if(validCols.length > 0) this.attemptMove(validCols[Math.floor(Math.random() * validCols.length)]);
    }
  }

  private minimax(board: number[][], depth: number, alpha: number, beta: number, maximizingPlayer: boolean): [number, number] {
    const validLocations = this.getValidLocations(board);
    if (this.checkWin(PLAYER_AI, board)) return [100000, -1];
    if (this.checkWin(PLAYER_HUMAN, board)) return [-100000, -1];
    if (validLocations.length === 0) return [0, -1];
    if (depth === 0) return [this.scorePosition(board, PLAYER_AI), -1];
    if (maximizingPlayer) {
      let value = -Infinity;
      let column = validLocations[Math.floor(Math.random() * validLocations.length)];
      for (const col of validLocations) {
        const row = this.getNextOpenRow(board, col);
        const bCopy = board.map(r => [...r]);
        bCopy[row][col] = PLAYER_AI;
        const newScore = this.minimax(bCopy, depth - 1, alpha, beta, false)[0];
        if (newScore > value) { value = newScore; column = col; }
        alpha = Math.max(alpha, value);
        if (alpha >= beta) break;
      }
      return [value, column];
    } else {
      let value = Infinity;
      let column = validLocations[Math.floor(Math.random() * validLocations.length)];
      for (const col of validLocations) {
        const row = this.getNextOpenRow(board, col);
        const bCopy = board.map(r => [...r]);
        bCopy[row][col] = PLAYER_HUMAN;
        const newScore = this.minimax(bCopy, depth - 1, alpha, beta, true)[0];
        if (newScore < value) { value = newScore; column = col; }
        beta = Math.min(beta, value);
        if (alpha >= beta) break;
      }
      return [value, column];
    }
  }

  private getValidLocations(board: number[][]): number[] {
    const valid = [];
    for (let c = 0; c < COLS; c++) if (board[ROWS - 1][c] === EMPTY) valid.push(c);
    return valid.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
  }

  private getNextOpenRow(board: number[][], col: number): number {
    for (let r = 0; r < ROWS; r++) if (board[r][col] === EMPTY) return r;
    return -1;
  }

  private scorePosition(board: number[][], piece: number): number {
    let score = 0;
    const centerArray = board.map(row => row[Math.floor(COLS/2)]);
    score += centerArray.filter(x => x === piece).length * 3;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        score += this.evaluateWindow([board[r][c], board[r][c+1], board[r][c+2], board[r][c+3]], piece);
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS; c++) {
        score += this.evaluateWindow([board[r][c], board[r+1][c], board[r+2][c], board[r+3][c]], piece);
      }
    }
    for (let r = 0; r < ROWS - 3; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        score += this.evaluateWindow([board[r][c], board[r+1][c+1], board[r+2][c+2], board[r+3][c+3]], piece);
      }
    }
    for (let r = 3; r < ROWS; r++) {
      for (let c = 0; c < COLS - 3; c++) {
        score += this.evaluateWindow([board[r][c], board[r-1][c+1], board[r-2][c+2], board[r-3][c+3]], piece);
      }
    }
    return score;
  }

  private evaluateWindow(window: number[], piece: number): number {
    let score = 0;
    const oppPiece = piece === PLAYER_HUMAN ? PLAYER_AI : PLAYER_HUMAN;
    const countPiece = window.filter(p => p === piece).length;
    const countEmpty = window.filter(p => p === EMPTY).length;
    const countOpp = window.filter(p => p === oppPiece).length;
    if (countPiece === 4) score += 100;
    else if (countPiece === 3 && countEmpty === 1) score += 5;
    else if (countPiece === 2 && countEmpty === 2) score += 2;
    if (countOpp === 3 && countEmpty === 1) score -= 4;
    return score;
  }
}