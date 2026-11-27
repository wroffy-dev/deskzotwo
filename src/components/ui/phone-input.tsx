"use client";

import { forwardRef, useState, type FocusEventHandler } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { PHONE_COUNTRIES, flagOf, joinPhone, phoneCountry, phoneCountryForZone, splitPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

/**
 * Every phone field in the app: the country first, picked from a list that shows each country's name
 * and code, then the number. The value in and out is the whole number as it is kept — "+91 9876543210"
 * (src/lib/phone.ts) — so a form holds one string as it always did.
 *
 * The country is a native `<select>` drawn as "🇮🇳 +91": closed, it takes no more room than the code;
 * open, it lists "India (+91)", "United Arab Emirates (+971)" … and a name can be typed to jump to it,
 * as in the address forms' country. On a phone it opens the system's own picker. A new number starts in
 * the workspace's country (from its time zone); a stored one is read for its own code, and one stored
 * without a code is taken to be in the workspace's country. Pasting a whole number with its code into
 * the number box picks the country from it.
 *
 * Give it `value` and `onChange` for a controlled field, or `name` (and `defaultValue`) for a form read
 * with FormData — a hidden input carries the whole number under that name. The ref is the number box,
 * for focusing it on an error.
 */
type PhoneInputProps = {
  id?: string;
  /** The whole number, "+91 98765 43210", or "". */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  /** Posts the whole number under this name, for a form read with FormData. */
  name?: string;
  /** The country a new number starts in, by ISO code. The workspace's when not given. */
  defaultCountry?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoComplete?: string;
  className?: string;
  /** The kiosk's size — a tablet's touch targets, not a desk's. */
  large?: boolean;
  /** Names the number box when no `<Label htmlFor>` points at it. */
  "aria-label"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
  "aria-required"?: boolean;
};

export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(function PhoneInput(
  { id, value, defaultValue, onChange, onBlur, name, defaultCountry, placeholder, disabled, readOnly, required, autoComplete = "tel-national", className, large = false, ...aria },
  ref,
) {
  const zone = useClock().zone;
  const fallback = defaultCountry ?? phoneCountryForZone(zone);
  const initial = value ?? defaultValue ?? "";
  const [parts, setParts] = useState(() => splitPhone(initial, fallback));
  const [seen, setSeen] = useState(initial);

  // A value changed from outside — a form reset, a record loaded — is read again; the value this field
  // just sent up is not, so the number keeps the spacing it was typed with. Adjusted during render, as
  // the other pickers do.
  if (value !== undefined && value !== seen) {
    setSeen(value);
    if (value !== joinPhone(parts.country, parts.national)) setParts(splitPhone(value, parts.country));
  }

  function emit(next: { country: string; national: string }) {
    setParts(next);
    const whole = joinPhone(next.country, next.national);
    setSeen(whole);
    onChange?.(whole);
  }

  const country = phoneCountry(parts.country);
  const locked = disabled || readOnly;

  return (
    <div className={cn("flex w-full min-w-0", className)}>
      <div className="relative shrink-0">
        <select
          aria-label="Country code"
          title={`${country.name} (+${country.dial})`}
          value={country.code}
          disabled={locked}
          onChange={(e) => emit({ country: e.target.value, national: parts.national })}
          className="peer absolute inset-0 z-10 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        >
          {PHONE_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} (+{c.dial})
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className={cn(
            "flex items-center gap-1 border border-r-0 border-line-strong bg-surface-sunken pl-2.5 pr-1.5 text-text shadow-sm",
            large ? "h-14 rounded-l-xl text-lg" : "h-9 rounded-l-base text-sm",
            "peer-focus-visible:border-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand",
            locked && "opacity-55",
          )}
        >
          <span className="leading-none">{flagOf(country.code)}</span>
          <span className="tabular-nums">+{country.dial}</span>
          <ChevronDown className="h-3.5 w-3.5 text-subtle" />
        </span>
      </div>
      <Input
        ref={ref}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        maxLength={20}
        value={parts.national}
        onChange={(e) => {
          const typed = e.target.value;
          // A whole number pasted in, code and all: its code picks the country.
          emit(/^\s*(\+|00)/.test(typed) ? splitPhone(typed, parts.country) : { country: parts.country, national: typed });
        }}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        className={cn("min-w-0 flex-1 rounded-l-none", large && "h-14 rounded-r-xl px-4 text-lg")}
        {...aria}
      />
      {name && <input type="hidden" name={name} value={joinPhone(parts.country, parts.national)} />}
    </div>
  );
});
