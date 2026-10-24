import SmartDnsComponent from "@/components/local-network/smartdns/smartdns";

// The route file is deliberately thin, exactly like its three siblings under
// `/local-network/`: it re-exports a client shell and holds no markup of its own.
//
// It cannot hold the header, because this file is a SERVER component and the
// page's motion cascade has to be rooted in a client one — a header written here
// snaps in while the cards below it fade, which is the defect that made the
// sibling routes move their headers into their shells.
const SmartDnsPage = () => {
  return <SmartDnsComponent />;
};

export default SmartDnsPage;
