import { I } from "./icons";

type IconProps = {
  name: keyof typeof I;
  size?: number;
  className?: string;
};

export default function Icon({
  name,
  size = 20,
  className,
}: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {name === "eval" ? (
        <>
          {/* Filled right half with rounded outer corners */}
          <path
            d="
              M12 9.5
              H19.25
              Q20.5 9.5 20.5 10.75
              V13.25
              Q20.5 14.5 19.25 14.5
              H12
              Z
            "
            fill="currentColor"
            stroke="none"
          />

          {/* Bar outline */}
          <rect
            x="3.5"
            y="9.5"
            width="17"
            height="5"
            rx="1.25"
            strokeWidth={0.9}
          />
        </>
      ) : (
        <path d={I[name]} />
      )}
    </svg>
  );
}