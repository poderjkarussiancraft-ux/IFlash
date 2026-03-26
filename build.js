const fs = require('fs');
const path = require('path');

// Загружаем переменные из .env (только для локальной разработки)
try {
  require('dotenv').config();
} catch (e) {
  console.log('⚠️ dotenv не установлен, пропускаем (для GitHub Actions это нормально)');
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Ошибка: SUPABASE_URL и SUPABASE_ANON_KEY не заданы.');
  console.error('   Локально: создайте файл .env и установите dotenv');
  console.error('   GitHub Actions: добавьте секреты в Settings → Secrets');
  process.exit(1);
}

// Шаблон теперь в папке www
const templatePath = path.join(__dirname, 'www', 'supabase-config.template.js');
const outputPath = path.join(__dirname, 'www', 'supabase-config.js');

if (!fs.existsSync(templatePath)) {
  console.error('❌ Ошибка: supabase-config.template.js не найден по пути:', templatePath);
  process.exit(1);
}

let template = fs.readFileSync(templatePath, 'utf8');
template = template.replace(/__SUPABASE_URL__/g, supabaseUrl);
template = template.replace(/__SUPABASE_ANON_KEY__/g, supabaseAnonKey);

fs.writeFileSync(outputPath, template);
console.log('✅ supabase-config.js успешно создан в папке www!');