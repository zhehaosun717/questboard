import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  // Guild badge: a small stamped plate — squared, hairline brass border, monospace numerals.
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[2px] border border-[#3a2a1c] bg-hall-edge px-2 py-0.5 font-mono text-xs font-semibold text-amber whitespace-nowrap shadow-[inset_0_0_6px_rgba(217,180,90,.15)] transition-all focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "border-[#8a6a24] bg-[#c9a24a] text-[#231a10] [a]:hover:bg-[#d4ad52]",
        secondary: "border-[#5a4230] bg-steel text-cream [a]:hover:bg-[#4b3624]",
        destructive: "border-[#6e1c16] bg-[#a8322a]/20 text-[#e58b7e] [a]:hover:bg-[#a8322a]/30",
        outline: "border-rivet text-cable [a]:hover:text-tag",
        ghost: "border-transparent bg-transparent text-dim [a]:hover:text-tag",
        link: "border-transparent bg-transparent text-rust underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
