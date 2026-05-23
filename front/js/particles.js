const canvas = document.getElementById('particles-canvas');
const ctx = canvas.getContext('2d');

let particles = [];
let mouse = { x: null, y: null };

function initParticles() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    particles = [];
    let count = Math.floor(window.innerWidth / 9);
    
    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.9,
            vy: (Math.random() - 0.5) * 0.9
        });
    }
}

function drawParticles() {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    particles.forEach((p, index) => {
        p.x += p.vx;
        p.y += p.vy;
        
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
        ctx.fill();

        let connections = 0;
        for (let j = index + 1; j < particles.length; j++) {
            let p2 = particles[j];
            let dist = Math.hypot(p.x - p2.x, p.y - p2.y);
            if (dist < 95 && connections < 5) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 - dist/95})`;
                ctx.lineWidth = 0.6;
                ctx.stroke();
                connections++;
            }
        }

        if (mouse.x) {
            let mouseDist = Math.hypot(p.x - mouse.x, p.y - mouse.y);
            if (mouseDist < 140) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(mouse.x, mouse.y);
                ctx.strokeStyle = `rgba(30, 80, 255, ${0.85 - mouseDist/140})`;
                ctx.lineWidth = 1.1;
                ctx.stroke();
            }
        }
    });
    
    requestAnimationFrame(drawParticles);
}

window.addEventListener('resize', () => {
    if (document.getElementById('login-screen') && document.getElementById('login-screen').classList.contains('active')) {
        initParticles();
    }
});

if (canvas) {
    canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    canvas.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });
    canvas.addEventListener('click', (e) => {
        for(let i = 0; i < 3; i++) {
            particles.push({
                x: e.clientX + (Math.random()-0.5)*18, 
                y: e.clientY + (Math.random()-0.5)*18, 
                vx: (Math.random() - 0.5) * 1.8, 
                vy: (Math.random() - 0.5) * 1.8
            });
        }
    });

    initParticles();
    drawParticles();
}