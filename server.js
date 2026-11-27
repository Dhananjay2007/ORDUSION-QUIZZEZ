const path = require('path');
const app = require('./api/index');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║      ORDUSION-QUIZZEZ Server Running     ║`);
  console.log(`  ║      http://localhost:${PORT}               ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
