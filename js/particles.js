const canvas = document.getElementById('particles-canvas');
const ctx = canvas.getContext('2d');

let particles = [];
let mouse = { x: null, y: null };

function initParticles() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    particles = [];
    let count = Math.floor(window.innerWidth / 10);
    
    for (let i = 0; i < count; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 1,
            vy: (Math.random() - 0.5) * 1
        });
    }
}

function drawParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    particles.forEach((p, index) => {
        p.x += p.vx;
        p.y += p.vy;
        
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.fill();

        let connections = 0;
        for (let j = index + 1; j < particles.length; j++) {
            let p2 = particles[j];
            let dist = Math.hypot(p.x - p2.x, p.y - p2.y);
            if (dist < 100 && connections < 6) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.strokeStyle = `rgba(255, 255, 255, ${1 - dist/100})`;
                ctx.lineWidth = 0.5;
                ctx.stroke();
                connections++;
            }
        }

        if (mouse.x) {
            let mouseDist = Math.hypot(p.x - mouse.x, p.y - mouse.y);
            if (mouseDist < 150) {
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(mouse.x, mouse.y);
                ctx.strokeStyle = `rgba(30, 80, 255, ${1 - mouseDist/150})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    });
    
    requestAnimationFrame(drawParticles);
}

window.addEventListener('resize', initParticles);
canvas.addEventListener('mousemove', (e) => { mouse.x = e.x; mouse.y = e.y; });
canvas.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });
canvas.addEventListener('click', (e) => {
    for(let i=0; i<3; i++) {
        particles.push({
            x: e.x + (Math.random()-0.5)*20, 
            y: e.y + (Math.random()-0.5)*20, 
            vx: (Math.random() - 0.5) * 2, 
            vy: (Math.random() - 0.5) * 2
        });
    }
});

initParticles();
drawParticles();