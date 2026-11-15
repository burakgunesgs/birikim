# Birikim: Supabase kurulumu

Veri artık Google Sheet'te değil, Supabase'te. Bu klasördeki her şey (tablolar, hesaplamalar, fiyat çekimi) sıfırdan
kurulabilir. Tek seferlik, yaklaşık 30 dakika. **Apps Script'e dokunma**: TV hâlâ oradan okuyor, 7. adıma kadar açık kalsın.

## Ne var

| Yer | Ne yapar |
|---|---|
| `migrations/0001_schema.sql` | Tablolar (varlıklar, aile, işlemler, fiyatlar), erişim kuralları (RLS) |
| `migrations/0002_logic.sql` | `Code.gs`'in hesapları: ortalama maliyet, aylık geçmiş, fiyat önerisi, ekle/sil. Uygulama sadece `api_*` fonksiyonlarını çağırır |
| `migrations/0003_cron.sql` | Fiyatları 10 dakikada bir çektirir (`pg_cron`) |
| `functions/fetch-prices` | Truncgil'den fiyat çeker, son iyi fiyatı ve günün kapanışını yazar |
| `functions/tv-holdings` | TV'nin okuduğu `?api=1` cevabının aynısı |
| `seed/price_history.sql` | İki yıllık günlük fiyat geçmişi (altın, gümüş, döviz). Kaynak ve doğruluk: `seed/README.md` |
| `admin/sheet-to-sql.mjs` | Sheet'teki "Hareketler"i SQL'e çevirir |

Güvenlik: kullanıcılar tabloya doğrudan yazamaz, sadece `api_add` / `api_delete` ile (kuralları orada kontrol edilir).
Herkes sadece kendi ailesinin işlemlerini görür. Fiyat tablolarına yalnızca `fetch-prices` yazar.

## 1. Proje

1. supabase.com'da yeni proje aç (bölge: Frankfurt, `eu-central-1`; veritabanı şifresini bir yere not et).
2. **Authentication → Providers → Email**: *Allow new users to sign up* kapalı olsun. Kullanıcıları sen ekleyeceksin.
3. **Authentication → Users → Add user**: aile bireylerinin e-posta ve şifresini oluştur (*Auto Confirm User* işaretli).
4. **Project settings → API**: `Project URL` ve `anon public` anahtarını `../config.js` dosyasına yaz (ikisi de
   herkese açık olabilir). `service_role` anahtarını **asla** buraya yazma.

> Ücretsiz projeler bir hafta kullanılmazsa duraklatılır. Fiyat çekimi veritabanında çalıştığı için bunun sayılıp
> sayılmadığını denemeden bilmiyorum; duraklarsa Pro plana geçmek ya da panelden yeniden başlatmak gerekir.

## 2. Tablolar ve fiyat geçmişi

Supabase CLI ile (`npx supabase`; ilk seferde **Account → Access Tokens**'tan bir token ister):

```bash
npx supabase login
npx supabase link --project-ref <proje-ref>     # veritabanı şifresini sorar
npx supabase db push                            # 0001, 0002, 0003
```

Fiyat geçmişini yükle: **SQL Editor**'de `seed/price_history.sql` dosyasının içeriğini yapıştırıp çalıştır (15.351
satır, tekrar çalıştırmak zararsız).

## 3. Fiyat çekimi

```bash
npx supabase functions deploy fetch-prices tv-holdings
npx supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"
```

`CRON_SECRET`'ı bir yere not et (bir sonraki adımda aynısı gerekiyor). Sonra **SQL Editor**'de, kendi değerlerinle:

```sql
select vault.create_secret('https://<proje-ref>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET değeri>', 'cron_secret');
```

On dakika içinde `select * from prices_latest;` dolu gelmeli. Elle denemek için:
`curl -X POST -H "x-cron-secret: <CRON_SECRET>" https://<proje-ref>.supabase.co/functions/v1/fetch-prices`.
Hata olursa **Edge Functions → fetch-prices → Logs**'a bak.

## 4. Aile

**SQL Editor**'de:

```sql
insert into households (name) values ('Güneş Ailesi') returning id;   -- çıkan id'yi not et

insert into household_members (household_id, user_id)
select '<household id>', id from auth.users where email in ('ilk@ornek.com', 'ikinci@ornek.com');
```

Sonradan birini eklemek için aynı ikinci sorgu. Bir kullanıcı bir aileye bağlı değilse uygulama "Hesabın bir aileye
bağlı değil" der.

## 5. Mevcut işlemleri aktar

1. Google Sheet'te **Hareketler** sayfası açıkken **Dosya → İndir → CSV**.
2. ```bash
   node admin/sheet-to-sql.mjs hareketler.csv --household <household id> > islemler.sql
   ```
   Sayıları Türkçe yazdıysa (`3.150,50`) ek ayar gerekmez; İngilizce ise `--locale en`. Okunamayan satırlar satır
   numarasıyla (içeriksiz) listelenir; onları elle ekle.
3. `islemler.sql`'i **SQL Editor**'de çalıştır. **CSV'yi ve SQL'i commit'leme** (kişisel veri).
4. Doğrula: uygulamayı aç, **toplam değer, maliyet ve satıştan kâr** eski uygulamadakiyle aynı olmalı. Bir fark varsa
   dur ve bana göster.

## 6. Uygulamayı yayınla

`config.js` doldurulmuş hâliyle commit'leyip GitHub Pages'e gönder. Telefonda e-posta ve şifreyle giriş yap.
Eski `#k=...` linki artık işe yaramaz; ana ekrandaki simge aynı adreste kalır.

## 7. TV'yi taşı (en son)

```bash
npx supabase secrets set TV_TOKEN="$(openssl rand -hex 24)" TV_HOUSEHOLD_ID="<household id>"
```

TV'deki `birikim.json` şu biçimde olmalı (TV kodu değişmez, aynı `?api=1&k=...` çağrısı):

```json
{"url": "https://<proje-ref>.supabase.co/functions/v1/tv-holdings", "key": "<TV_TOKEN>"}
```

Not: `tv-vibehack/my-tv/birikim-push.sh` yalnızca `script.google.com` adreslerini kabul ediyor; yeni adres için ya o
betik güncellenmeli ya da dosya elle yazılmalı. TV'de **Hamit Altın** (`HAMITALTIN`) yeni bir kod: TV'nin fiyat tablosunda
yoksa o varlık değersiz görünür.

TV çalışınca Apps Script web uygulamasını **Dağıtımları yönet**'ten kaldır. Sheet'i yedek olarak sakla.

## Testler

Kök klasörde `npm install && npm test`: veritabanı (kurallar, hesaplar, `Code.gs` ile karşılaştırma), uygulama (giriş,
ekleme, silme), fiyat çekimi ve aktarım betiği. Hepsi yerelde çalışır; Supabase'e bağlanmaz.
