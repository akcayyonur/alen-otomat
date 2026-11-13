/**
 * Numune takipte (EYS.FR.012) YENİ Alen ürün kodu oluşturmak için kullanılan sabit müşteri grubu listesi
 * (kullanıcı verdi, 2026-11-13). Kodun EN SONUNDAKİ üç hane bu grubu gösterir (ör. "SR016.011" → 011 = Konveyör).
 *
 * Aşağıdaki duruş kodu listesiyle (`shared/downtime-codes.js`) AYNI ilke: sabit, kodda tutulan bir liste —
 * yönetici ekranından düzenlenemez, yeni bir grup eklenecekse buraya elle eklenir.
 *
 * Tek tanım: dashboard/planning-numune.js AYNI listeyi (dashboard backend dosyalarını import edemediği için,
 * `card-steps.js`/`dashboard/planning-card.js` deseniyle AYNI) kopyalar; eşitlik `sample-tracking.test.js`'te sınanır.
 */
export const SAMPLE_CUSTOMER_GROUPS = Object.freeze([
  Object.freeze({ code: '001', name: 'Siamp' }),
  Object.freeze({ code: '002', name: 'Ayvaz' }),
  Object.freeze({ code: '003', name: 'Başkent' }),
  Object.freeze({ code: '004', name: 'Worimex' }),
  Object.freeze({ code: '005', name: 'Platinflex' }),
  Object.freeze({ code: '006', name: 'Kuzuflex' }),
  Object.freeze({ code: '007', name: 'Havana' }),
  Object.freeze({ code: '008', name: 'Ayvaz N' }),
  Object.freeze({ code: '009', name: 'Zeplin' }),
  Object.freeze({ code: '010', name: 'Hanatech' }),
  Object.freeze({ code: '011', name: 'Konveyör' }),
  Object.freeze({ code: '012', name: 'Ayvaz Serbest Bölge' }),
  Object.freeze({ code: '013', name: 'Berg Metal' }),
  Object.freeze({ code: '014', name: 'BHW Kontrol' }),
  Object.freeze({ code: '015', name: 'Taytech' }),
  Object.freeze({ code: '016', name: 'Qmet' }),
  Object.freeze({ code: '017', name: 'Maxheat' }),
  Object.freeze({ code: '018', name: 'Pipefit' }),
  Object.freeze({ code: '019', name: 'Klinger' }),
]);

export const SAMPLE_CODE_PREFIXES = Object.freeze(['SR', 'Nİ']);

export function sampleGroupByCode(code) {
  return SAMPLE_CUSTOMER_GROUPS.find((g) => g.code === String(code ?? '').trim()) ?? null;
}
