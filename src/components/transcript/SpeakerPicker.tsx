import { useEffect, useRef, useState } from "react";
import { Check, Plus, User, UserX } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface SpeakerPickerProps {
  value: string | null;
  speakers: string[];
  onChange: (name: string | null) => void;
}

/** Pick an existing speaker, type a new name, or clear the label. */
const SpeakerPicker = ({ value, speakers, onChange }: SpeakerPickerProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const isNew = typed.length > 0 && !speakers.some((s) => s.toLowerCase() === typed.toLowerCase());

  const choose = (name: string | null) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };

  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // The popover is only built once someone opens it: a long transcript has thousands of these.
  // When it closes, put focus back on the button.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const trigger = (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setOpen(true)}
      aria-haspopup="dialog"
      aria-label={value ? `Speaker: ${value}. Change speaker` : "No speaker. Add a speaker"}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        value
          ? "border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20"
          : "border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {value ? <User className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Plus className="h-3 w-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{value ?? "Speaker"}</span>
    </button>
  );

  if (!open) return trigger;

  return (
    <Popover open onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Find or type a name…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>Type a name to add a speaker.</CommandEmpty>
            {speakers.length > 0 && (
              <CommandGroup heading="Speakers">
                {speakers.map((name) => (
                  <CommandItem key={name} value={name} onSelect={() => choose(name)}>
                    <Check className={cn("mr-2 h-4 w-4", name === value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                    {name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {/* forceMount: the list hides a group with no filter matches, which would hide "Add" while typing a new name */}
            <CommandGroup forceMount>
              {isNew && (
                <CommandItem forceMount value={`__new__${typed}`} onSelect={() => choose(typed)}>
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add “{typed}”
                </CommandItem>
              )}
              {value && (
                <CommandItem forceMount value="__none__" onSelect={() => choose(null)}>
                  <UserX className="mr-2 h-4 w-4" aria-hidden="true" /> No speaker
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default SpeakerPicker;
