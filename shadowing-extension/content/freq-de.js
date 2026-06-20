/* freq-de.js — Danh sach tu tieng Duc thong dung (top ~500), de TO MAU theo tan suat
 * kieu Language Reactor: tu KHONG nam trong danh sach nay = tu hiem/dang hoc -> highlight.
 * Dung trong Side Panel (window.SD_FREQ_DE) va content script.
 * Nguon: tong hop tu cac danh sach tan suat tieng Duc pho bien (function words + content words). */
(function (root) {
  'use strict';
  const WORDS = (
    'der die das ein eine einen einem einer eines den dem des ' +
    'und oder aber denn sondern doch wenn weil dass ob als wie wo wann warum ' +
    'ich du er sie es wir ihr mich dich ihn uns euch mir dir ihm ihnen mein dein sein ihre unser euer ' +
    'nicht kein keine nichts nie nur noch schon sehr auch mehr wenig viel mehr meist ganz fast etwa ' +
    'ist sind war waren bin bist seid sei gewesen werden wird wurde wurden geworden ' +
    'haben hat hatte hatten habe hast habt gehabt ' +
    'kann kannst koennen konnte muss musst muessen musste soll sollen sollte will willst wollen wollte ' +
    'mag moegen darf duerfen machen macht gemacht machte tun tut getan ' +
    'gehen geht ging gegangen kommen kommt kam gekommen sehen sieht sah gesehen ' +
    'sagen sagt sagte gesagt geben gibt gab gegeben nehmen nimmt nahm genommen ' +
    'finden findet fand gefunden denken denkt dachte gedacht wissen weiss wusste gewusst ' +
    'bleiben bleibt blieb geblieben stehen steht stand gestanden liegen liegt lag gelegen ' +
    'in im an am auf aus bei mit nach seit von vor zu zur zum ueber unter neben zwischen durch fuer gegen ohne um ' +
    'hier da dort jetzt dann heute morgen gestern immer oft manchmal wieder ' +
    'gut schlecht gross klein neu alt jung lang kurz hoch tief schnell langsam schoen ' +
    'ja nein vielleicht bitte danke gern leider natuerlich genau richtig falsch ' +
    'mann frau kind leute mensch menschen tag nacht jahr jahre zeit stunde woche monat ' +
    'haus stadt land welt weg arbeit geld wasser essen name wort sache ' +
    'eins zwei drei vier fuenf sechs sieben acht neun zehn hundert tausend ' +
    'alle alles jeder jede jedes manche einige beide andere dieser diese dieses jenes ' +
    'mal so dann also weil obwohl trotzdem deshalb darum nun eben halt mal ' +
    'dieser welche solche selbst sogar fast ziemlich besonders eigentlich wirklich ' +
    'machen lassen laesst liess gelassen halten haelt hielt gehalten bringen bringt brachte gebracht ' +
    'sprechen spricht sprach gesprochen leben lebt lebte gelebt arbeiten heissen hiess ' +
    'fahren faehrt fuhr gefahren laufen laeuft lief gelaufen spielen lernen lieben brauchen ' +
    'glauben fuehlen zeigen fragen antworten warten suchen versuchen verstehen begin beginnen ' +
    'mehr weniger genug zu schon erst spaet frueh bald gleich vorbei zusammen allein ' +
    'gegen ohne statt waehrend wegen trotz innerhalb ausserhalb '
  ).split(/\s+/).filter(Boolean);
  const SET = new Set(WORDS);
  // Tu thong dung neu nam trong SET (sau khi bo dau & chu thuong)
  function isCommon(word) {
    const w = String(word || '').toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 's')
      .replace(/[^a-z]/g, '');
    if (!w || w.length <= 2) return true; // tu rat ngan: coi nhu thong dung, khong highlight
    return SET.has(w);
  }
  root.SD_FREQ_DE = { SET, isCommon };
  if (typeof window !== 'undefined') window.SD_FREQ_DE = root.SD_FREQ_DE;
})(typeof window !== 'undefined' ? window : this);
