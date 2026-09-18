import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[2px] border border-transparent bg-clip-padding font-han text-sm font-bold tracking-[.06em] whitespace-nowrap transition-[transform,background-color,background-image,box-shadow,border-color,color] duration-100 outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // Guild variants: a button is a brass-and-steel plate pressed into the board, not a rounded bubble.
      // The 3px bottom shadow is the plate's thickness; pressing it moves down by that much.
      variant: {
        default:
          "border-[#5a4230] bg-[linear-gradient(180deg,#4b3624,#3a2a1c)] text-cream shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_3px_0_#0f0c09] hover:bg-[linear-gradient(180deg,#5c4331,#45311f)] hover:text-tag active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_1px_0_#0f0c09]",
        gold:
          "border-[#8a6a24] bg-[linear-gradient(180deg,#e2c276,#c9a24a)] text-[#231a10] shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_3px_0_#5c4315] hover:bg-[linear-gradient(180deg,#edcf86,#d4ad52)] active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_1px_0_#5c4315]",
        outline:
          "border-rivet bg-transparent text-cable hover:border-cable hover:text-tag",
        secondary:
          "border-oak-deep bg-oak-deep text-cable hover:text-tag",
        ghost:
          "border-transparent bg-transparent text-dim hover:bg-white/5 hover:text-tag",
        destructive:
          "border-[#6e1c16] bg-[linear-gradient(180deg,#a8322a,#7d231c)] text-[#f6dcd5] shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_3px_0_#3d0f0c] hover:bg-[linear-gradient(180deg,#b93a31,#8a2720)] active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_1px_0_#3d0f0c]",
        link: "border-transparent bg-transparent text-rust underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 px-2 text-[11px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[12px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
