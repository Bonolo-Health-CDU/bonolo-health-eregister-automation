import { Box } from "@mantine/core";
import crest from "../assets/moh-crest.png";
import logo from "../assets/moh-logo.png";

const ALT = "Ministry of Health, Lesotho";

// The emblem is shown on a white plate in both colour schemes: its shield is
// transparent inside, and an official emblem is not recoloured for dark mode.
const plate = { background: "#fff", borderRadius: 8, lineHeight: 0, display: "inline-block" } as const;

/** The crest alone, for the header. */
export const MohCrest = ({ height = 36 }: { height?: number }) => (
  <Box style={{ ...plate, borderRadius: 6, padding: 2 }}>
    <img src={crest} alt={ALT} height={height} width={Math.round((height * 55) / 72)} />
  </Box>
);

/** The full logo with its "Ministry of Health" caption, for full-page states. */
export const MohLogo = ({ height = 120 }: { height?: number }) => (
  <Box style={{ ...plate, padding: 8 }}>
    <img src={logo} alt={ALT} height={height} width={Math.round((height * 250) / 258)} />
  </Box>
);
