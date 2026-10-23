"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// "Go to" palette (Ctrl/Cmd+K). It reads the same nav groups as the sidebar,
// so it never offers a page the user could not open from the sidebar.
export default function CommandMenu({ groups }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(href) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-muted-foreground max-sm:size-8 max-sm:p-0 sm:w-44 sm:justify-start"
        onClick={() => setOpen(true)}
        aria-label="Go to page"
      >
        <Search aria-hidden="true" />
        <span className="max-sm:hidden">Go to…</span>
        <kbd className="ml-auto text-xs max-sm:hidden">Ctrl K</kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Go to page"
        description="Search the pages you can open."
      >
        <Command>
          <CommandInput placeholder="Search pages" />
          <CommandList>
            <CommandEmpty>No page matches that.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.id} heading={group.label || "Pages"}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`${group.label || ""} ${item.label}`}
                    onSelect={() => go(item.href)}
                  >
                    <item.icon aria-hidden="true" />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
