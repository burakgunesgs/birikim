# Fiyat geçmişi

`price_history.csv` (ve ondan üretilen `price_history.sql`): 21 varlık × 731 gün, 2024-11-15 ile 2026-11-15 arası,
günlük alış ve satış. Sütunlar: `day, code, buy, sell, source, estimated`.

Bu dosya bir kez, 2026-11-15'te derlendi. Bugünden sonrasını `fetch-prices` günlük yazar.

| `source` | Ne | Güven |
|---|---|---|
| `kapalicarsi` | 21 Mayıs 2026 sonrası, Truncgil'in günlük görüntüsü (`kessinc/darphane` deposunun commit geçmişi) | Gerçek |
| `kuyumaltin` | Gram altın günlük kapanış (kuyumaltin.com, 2024-01 ile 2026-08-25 arası) | İyi: 6 aylık gerçek veriyle hafta içi sapma %0,8 (en çok %3,7, oynak günlerde) |
| `tcmb` | USD, EUR, GBP, CHF efektif alış/satış (tcmb.gov.tr arşivi) | Resmi |
| `yahoo_tahmin` | Gümüş: ons × dolar × 1,0005. Gram altın: ons × dolar × 0,9949 (yalnızca kuyumaltin'de boş kalan gün) | Tahmin; gümüşte 6 ayda %0,65 sapma |
| `oran_tahmin` | Gram dışındaki altın türleri (çeyrek, yarım, tam, Cumhuriyet, Ata, Reşat, Hamit, İkibuçuk, Beşli, Gremse, 22/18/14 ayar): o günün gram fiyatı × türün 6 aylık gerçek veriden çıkan alış ve satış oranı | Tahmin: çeyrekte 3 bağımsız haber fiyatına karşı %0,2 ile %2,0 düşük |
| `devir` | Hafta sonu ve resmi tatil: son iş gününün fiyatı | Piyasa kapalı, değer aynı |
| `truncgil` | Canlı kaynakla yazılan döviz kapanışı | Gerçek (banka kuru: TCMB efektif kurdan %0,4 kadar dar makas) |

`estimated = true` olan satırlar uygulamada "Yaklaşık" diye gösterilir (`api_price_at`, `api_history`).

Dikkat:
- 22, 18 ve 14 ayarın **satış** fiyatı güvenilmez: alış–satış farkı zamanla çok değişiyor (bugün %3,6, 6 aylık ortalama %0,2).
- Türlerin gram altına oranı sabit sayıldı; fiyat düzeyi çok farklı olan dönemlerde (2025 başı) küçük sapma olabilir.
- 21 Mayıs 2026 öncesi gerçek Kapalıçarşı fiyatı için kaynak bulunamadı. Daha iyi bir kaynak bulunursa aynı sütunlarla
  yeniden yüklenebilir (`on conflict` satırı günceller).
