// Daily-note name formatting (a Moment.js token subset — what Obsidian's
// daily-notes plugin uses) and {{date}}/{{time}}/{{title}} template filling.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Thrown for Moment tokens we don't implement — callers fall back and warn
 * instead of silently writing a wrong filename into a shared vault. */
export class UnsupportedTokenError extends Error {
  constructor(token: string) {
    super(`unsupported date token "${token}"`);
  }
}

const ordinal = (n: number): string => {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]);
};

/** ISO week number + ISO week-year. */
function isoWeek(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const year = t.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const fDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
  return { week, year };
}

/**
 * Format `d` with a Moment token subset (what Obsidian's daily/weekly notes
 * use): YYYY YY MMMM MMM MM M DD D Do dddd ddd dd d HH H hh h mm m ss s A a
 * ww w WW W gggg GGGG Q, with `[literal]` escapes. Every homogeneous run is
 * consumed whole; an unsupported alphabetic token THROWS rather than silently
 * producing a wrong filename (e.g. Moment's DDD = day-of-year).
 */
export function formatMoment(d: Date, fmt: string): string {
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === "[") {
      const close = fmt.indexOf("]", i);
      if (close === -1) {
        out += fmt.slice(i + 1);
        break;
      }
      out += fmt.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    let run = 1;
    while (i + run < fmt.length && fmt[i + run] === ch) run++;
    // `Do` is the one heterogeneous token.
    if (ch === "D" && run === 1 && fmt[i + 1] === "o") {
      out += ordinal(d.getDate());
      i += 2;
      continue;
    }
    const token = fmt.slice(i, i + run);
    const piece = tokenValue(d, token);
    if (piece === null) throw new UnsupportedTokenError(token);
    out += piece;
    i += run;
  }
  return out;
}

function tokenValue(d: Date, token: string): string | null {
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  switch (token) {
    case "YYYY":
      return String(d.getFullYear());
    case "YY":
      return pad(d.getFullYear() % 100);
    case "MMMM":
      return MONTHS[d.getMonth()];
    case "MMM":
      return MONTHS[d.getMonth()].slice(0, 3);
    case "MM":
      return pad(d.getMonth() + 1);
    case "M":
      return String(d.getMonth() + 1);
    case "DD":
      return pad(d.getDate());
    case "D":
      return String(d.getDate());
    case "dddd":
      return DAYS[d.getDay()];
    case "ddd":
      return DAYS[d.getDay()].slice(0, 3);
    case "dd":
      return DAYS[d.getDay()].slice(0, 2);
    case "d":
      return String(d.getDay());
    case "HH":
      return pad(h24);
    case "H":
      return String(h24);
    case "hh":
      return pad(h12);
    case "h":
      return String(h12);
    case "mm":
      return pad(d.getMinutes());
    case "m":
      return String(d.getMinutes());
    case "ss":
      return pad(d.getSeconds());
    case "s":
      return String(d.getSeconds());
    case "A":
      return h24 < 12 ? "AM" : "PM";
    case "a":
      return h24 < 12 ? "am" : "pm";
    case "ww":
    case "WW":
      return pad(isoWeek(d).week);
    case "w":
    case "W":
      return String(isoWeek(d).week);
    case "gggg":
    case "GGGG":
      return String(isoWeek(d).year);
    case "Q":
      return String(Math.floor(d.getMonth() / 3) + 1);
    default:
      return null;
  }
}

/** Fill an Obsidian template: {{date}}, {{date:FMT}}, {{time}}, {{time:FMT}},
 * {{title}} (case-insensitive keys). */
export function fillTemplate(tpl: string, d: Date, title: string): string {
  return tpl.replace(/\{\{(date|time|title)(?::([^}]+))?\}\}/gi, (_, key: string, fmt?: string) => {
    switch (key.toLowerCase()) {
      case "title":
        return title;
      case "date":
        return formatMoment(d, fmt ?? "YYYY-MM-DD");
      case "time":
        return formatMoment(d, fmt ?? "HH:mm");
      default:
        return "";
    }
  });
}
